"""
M71 Slice C(a) — Governance oracle.

The orchestrator that takes (current phase state, agent output) and returns
(next phase state, dispatched tool results, audit events). It does NOT
drive the LLM itself — that's Slice C(b)'s wrapper. This module is the
trustworthy core: pure orchestration over the phase machine, policy
loader, tool gateway, validators, and dispatch client.

Why split it this way: the oracle is testable without a real LLM. Anyone
building a new agent runtime against Singularity can call this and trust
that policy is enforced — without having to integrate llm-gateway too.

Typical call flow from workgraph-api (today) or the LLM wrapper
(Slice C(b)):

    state = PhaseState.from_dict(session.metadata.phase_state)
    result = await governed_step(
        state=state,
        agent_output={"phase_complete": True, "payload": {...}},
        tool_calls=[{"tool_name": "apply_patch", "args": {...}}],
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        run_context={...},
    )
    session.metadata.phase_state = result.next_state.to_dict()

The result carries every decision (phase advance, tool refusals, tool
results, validation errors) so the caller can render the right thing
to the operator and/or feed back into the LLM for the next turn.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from .audit_emit import emit_governed_event
from .dispatch import ToolDispatchError, ToolDispatchResult, dispatch_tool
from .path_coverage import check_path_coverage
from .phase_state import Phase, PhaseState, advance_phase
from .pii_mask import mask_pii_in_result, unmask_pii_in_args
from .verify_synthesis import synthesize_verifier_run
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
from .tool_gateway import PhaseToolForbidden, check_tool_allowed
from .validators import PhaseOutputInvalid, validate_phase_output

log = logging.getLogger(__name__)


@dataclass
class ToolCallOutcome:
    """One element of `GovernedStepResult.tool_outcomes`. Each entry tells
    the caller (a) was this call refused on policy grounds, (b) if dispatched,
    did the underlying tool succeed."""

    tool_name: str
    phase: str
    allowed: bool
    # M73-followup #4 — keep the args the LLM emitted on this call. Used by
    # stage_driver._history_from_turn to re-construct the assistant message
    # with FULL tool_calls (id + name + arguments). Without this, when a
    # stage pauses for human approval and later resumes, the LLM is restarted
    # from persisted history with empty arguments on prior tool calls — at
    # which point "the LLM has them in its memory" is false by construction.
    # Cost is one JSON-serializable dict per call; correctness is unbounded.
    args: dict[str, Any] = field(default_factory=dict)
    refusal_reason: str | None = None
    allowed_tools: list[str] = field(default_factory=list)
    result: Any = None
    duration_ms: int = 0
    tool_invocation_id: str | None = None
    tool_success: bool | None = None
    tool_error: str | None = None
    dispatch_error: str | None = None


@dataclass
class GovernedStepResult:
    """Everything that happened this turn. Caller persists `next_state` and
    relays `tool_outcomes` / `phase_advance` / `validation_error` to the LLM
    or the operator UI as appropriate."""

    next_state: PhaseState
    # If a phase_output was supplied and validated, the parsed receipt lives
    # here. None when the turn only fired tool calls without finishing a phase.
    receipt: dict[str, Any] | None = None
    # The phase BEFORE this step, for audit + UI animations.
    from_phase: str = ""
    # The phase AFTER this step. Equal to from_phase when nothing advanced.
    to_phase: str = ""
    phase_advanced: bool = False
    # Outcomes per tool call, in dispatch order. Empty when no tool calls.
    tool_outcomes: list[ToolCallOutcome] = field(default_factory=list)
    # When validation failed, the raw validator details bubble up here so
    # the LLM wrapper (Slice C(b)) can format them as a tool-result message
    # for the next turn.
    validation_error: dict[str, Any] | None = None
    # M74 Phase 1A — when the orchestrator auto-verified after an
    # EditReceipt, the result lands here. stage_driver reads this and
    # injects a system-style user message into the next turn's prompt
    # so the LLM sees the verifier output before producing its
    # VerificationReceipt. None on non-ACT advances or when no edits.
    synthetic_verifier: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "next_state": self.next_state.to_dict(),
            "receipt": self.receipt,
            "from_phase": self.from_phase,
            "to_phase": self.to_phase,
            "phase_advanced": self.phase_advanced,
            "tool_outcomes": [asdict(o) for o in self.tool_outcomes],
            "validation_error": self.validation_error,
            "synthetic_verifier": self.synthetic_verifier,
        }


def _normalize_tool_call(raw: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Accept either `{tool_name, args}` or LLM-style `{name, arguments}`.

    LLM tool-call shapes vary by provider; this helper normalises into the
    shape `dispatch_tool` expects. Unknown shapes raise ValueError so the
    caller's bug is loud rather than silent.
    """
    name = raw.get("tool_name") or raw.get("name")
    if not name or not isinstance(name, str):
        raise ValueError(f"tool call missing tool_name/name: {raw!r}")
    args = raw.get("args")
    if args is None:
        args = raw.get("arguments", {})
    if not isinstance(args, dict):
        raise ValueError(f"tool call args must be an object: {raw!r}")
    return name, args


# Tools that legitimately mutate code. Mirrors the EditEntry.edit_type
# Literal in receipts.py — the receipt validator restricts edit_type to
# this same set so a future addition is caught at both layers.
_MUTATING_TOOLS = frozenset({
    "apply_patch",
    "replace_text",
    "replace_range",
    "create_file",
    "write_file",
    "finish_work_branch",
})


def _normalise_change_path(path: str) -> str:
    """Normalise a file path the same way path_coverage does so the
    EditReceipt validator's set comparison sees the same canonical
    form on both sides."""
    p = (path or "").strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p


def _extract_code_changes(
    *,
    tool_name: str,
    result: Any,
    tool_success: bool | None,
) -> list[tuple[str, str]]:
    """Pull (file_path, change_id) pairs from a successful mutating
    tool's result envelope. Returns [] when the tool isn't mutating,
    didn't succeed, or didn't surface a change_id.

    Recognised aliases on the result dict mirror what workgraph-api's
    orchestrator.ts:adaptGovernedStageToCodingRun already scans for
    (code_change_id / codeChangeId / changeId / change_id) plus the
    file field variants (file / path / file_path / target_file).

    Multiple files per call (e.g. a batch apply_patch) are picked up
    via an optional `files` / `changed_files` list on the envelope.
    """
    if tool_name not in _MUTATING_TOOLS:
        return []
    # `tool_success is False` blocks; `tool_success is None` (older
    # tools don't always set the flag) is treated as ok so we don't
    # silently drop a legitimately-edited file.
    if tool_success is False:
        return []
    if not isinstance(result, dict):
        return []

    change_id = (
        result.get("code_change_id")
        or result.get("codeChangeId")
        or result.get("changeId")
        or result.get("change_id")
    )
    if not isinstance(change_id, str) or not change_id:
        # No change_id surfaced — can't bind. Returning [] here means
        # the receipt validator will reject the file as unbacked. That's
        # the intended safety behavior: if the tool didn't emit a
        # change_id we can't prove the edit happened.
        return []

    # Pull the file path(s). Single-file shape first.
    single = (
        result.get("file")
        or result.get("path")
        or result.get("file_path")
        or result.get("target_file")
    )
    paths: list[str] = []
    if isinstance(single, str) and single.strip():
        paths.append(single)
    # Batch shape: a list of file paths on `files` or `changed_files`.
    for batch_key in ("files", "changed_files"):
        batch = result.get(batch_key)
        if isinstance(batch, list):
            paths.extend(p for p in batch if isinstance(p, str) and p.strip())

    if not paths:
        return []
    return [(_normalise_change_path(p), change_id) for p in paths]


def _truncate_oversize_strings(
    value: Any, max_chars: int,
) -> tuple[Any, int]:
    """Walk an arbitrary JSON-like value; replace any string longer
    than max_chars with `prefix + "...[truncated N chars by policy]"`
    where prefix is the first (max_chars - marker_len) characters.

    Returns (truncated_value, total_bytes_truncated). When
    total_bytes_truncated == 0 the input was untouched and the
    caller can skip the audit event.

    Mirrors mask_pii_in_result's recursive walk so the cap reaches
    string leaves at any depth in the result envelope (nested
    `lines: [...]`, `content`, etc.). Lists and dicts are walked
    structurally; non-string leaves pass through.
    """
    total_truncated = 0

    def _walk(v: Any) -> Any:
        nonlocal total_truncated
        if isinstance(v, str):
            if len(v) <= max_chars:
                return v
            marker = f"\n...[truncated {len(v) - max_chars} chars by policy]"
            total_truncated += len(v) - max_chars
            keep = max_chars - len(marker)
            if keep < 0:
                # max_chars is smaller than the marker itself; pathological
                # but possible. Just emit the marker alone.
                return marker
            return v[:keep] + marker
        if isinstance(v, list):
            return [_walk(x) for x in v]
        if isinstance(v, dict):
            return {k: _walk(x) for k, x in v.items()}
        return v

    truncated = _walk(value)
    return truncated, total_truncated


def _check_edit_receipt_provenance(
    *,
    receipt: dict[str, Any],
    produced_changes: dict[str, list[str]],
) -> list[str]:
    """Return the list of edit-receipt file paths that have NO backing
    code_change_id from a successful mutating-tool dispatch.

    Empty list = every claim is backed by evidence → receipt accepted.
    Non-empty = the receipt is over-claiming → reject with
    PHASE_EDIT_UNBACKED.

    skipped_targets entries are exempt — the agent explicitly declared
    those as "decided not to edit", which doesn't need a code_change_id.
    """
    edits = receipt.get("edits") or []
    if not isinstance(edits, list):
        return []
    unbacked: list[str] = []
    for entry in edits:
        if not isinstance(entry, dict):
            continue
        path = entry.get("file") or entry.get("path")
        if not isinstance(path, str) or not path.strip():
            continue
        canonical = _normalise_change_path(path)
        if canonical not in produced_changes or not produced_changes[canonical]:
            unbacked.append(path)
    return unbacked


async def governed_step(
    *,
    state: PhaseState,
    stage_key: str,
    agent_role: str | None,
    tool_calls: list[dict[str, Any]] | None = None,
    phase_output: dict[str, Any] | None = None,
    next_phase: Phase | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
    policy: StagePolicy | None = None,
) -> GovernedStepResult:
    """Run one governed turn.

    Order of operations:

      1. Load StagePolicy if not provided (cached by policy_loader).
      2. If tool_calls present:
           For each: check_tool_allowed() → if refused, capture refusal
           with allowlist (the LLM can pick a valid tool next turn);
           if allowed, dispatch via /mcp/tool-run and capture the result.
      3. If phase_output present:
           validate_phase_output() → raises PhaseOutputInvalid on shape
           failures. We catch + put it on `validation_error` so the caller
           can choose to retry the same phase rather than abort.
      4. If phase_output validated AND next_phase declared:
           advance_phase() — appends the receipt, bumps repair_attempts
           where applicable, sets approval_pending on SELF_REVIEW.
      5. Emit a `governed.step` audit-gov event with the full outcome.

    Refused tool calls do NOT block the turn. The LLM wrapper (Slice C(b))
    is responsible for feeding the refusal back to the model so it can
    retry with an allowed tool. This is the "self-correct" path baked into
    the spec's PHASE_TOOL_FORBIDDEN error.

    Validation failures DO block phase advancement. They don't advance the
    machine; the caller is expected to surface the structured details to
    the LLM so it can fix the receipt and retry the same phase.
    """
    tool_calls = tool_calls or []
    if policy is None:
        try:
            policy = await load_stage_policy(stage_key, agent_role, bearer=bearer)
        except PolicyNotFoundError:
            # No policy means we have no allowlist. Hard refuse everything;
            # the caller must seed a policy before calling this stage.
            raise

    result = GovernedStepResult(
        next_state=state,
        from_phase=state.current_phase.value,
        to_phase=state.current_phase.value,
    )

    # ── 1. Tool dispatch with hard-refuse policy ──────────────────────────

    for raw in tool_calls:
        try:
            tool_name, args = _normalize_tool_call(raw)
        except ValueError as exc:
            log.warning("malformed tool call payload: %s", exc)
            # Best-effort args grab for malformed calls — the LLM still
            # needs to see something in the round-tripped history. If
            # the payload is genuinely garbled, default-factory {} is fine.
            raw_args = raw.get("args") or raw.get("arguments") or {}
            if not isinstance(raw_args, dict):
                raw_args = {}
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=str(raw.get("name") or raw.get("tool_name") or "<unknown>"),
                    phase=state.current_phase.value,
                    allowed=False,
                    args=raw_args,
                    refusal_reason=f"malformed tool call: {exc}",
                )
            )
            continue

        try:
            check_tool_allowed(policy, state.current_phase, tool_name)
        except PhaseToolForbidden as refusal:
            log.info(
                "tool refused tool=%s phase=%s policy=%s",
                tool_name,
                state.current_phase.value,
                policy.policy_id,
            )
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=tool_name,
                    phase=state.current_phase.value,
                    allowed=False,
                    args=args,
                    refusal_reason=refusal.reason,
                    allowed_tools=list(refusal.allowed_tools),
                )
            )
            await emit_governed_event(
                kind="governed.tool_refused",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "tool_name": tool_name,
                    "reason": refusal.reason,
                    "allowed_tools": list(refusal.allowed_tools),
                },
                severity="warn",
            )
            continue

        # Allowed → dispatch to mcp-server's /mcp/tool-run.
        #
        # M73-followup #93 — multi-turn PII protection around the dispatch:
        #   1. The LLM may have emitted tokens (e.g. {"to": "[EMAIL_1]"})
        #      that came from a prior masked tool result. Unmask args
        #      before sending to the tool — the downstream API expects
        #      the real email, not the token literal.
        #   2. The tool returns real PII in its output. Mask before the
        #      result lands in ToolCallOutcome (which feeds the next
        #      turn's prompt history) so the LLM never sees raw values.
        #   3. Token map persists on state.pii_token_map across turns
        #      AND across pause/resume (PhaseState.to_dict round-trips
        #      it). Same (kind, value) gets the same token across the
        #      whole stage so the LLM can reason about identity.
        # M75 Slice 4 — route via laptop bridge when the caller asked for it.
        # prefer_laptop semantics (lifted from legacy execute.py + pinned in
        # docs/M75-laptop-bridge-cutover.md):
        #   • True  → use the user's laptop bridge. If no bridge is
        #             connected, dispatch.py's _LaptopUnavailable → HTTP
        #             fallback fires (silent fallback; stricter "require
        #             laptop" check lives upstream at the request entry
        #             if a caller needs 503 on missing bridge).
        #   • False → never use laptop; force HTTP. (Workgraph QA stages
        #             explicitly set this so they hit the managed runtime
        #             regardless of laptop availability.)
        #   • None  → HTTP only. Auto-prefer-when-available is a future
        #             optimisation that requires upstream "is bridge live?"
        #             plumbing we don't have yet.
        run_ctx = run_context or {}
        prefer_laptop = run_ctx.get("prefer_laptop")
        ctx_user_id = run_ctx.get("user_id") or run_ctx.get("userId")
        laptop_user_id = (
            str(ctx_user_id)
            if prefer_laptop is True and ctx_user_id
            else None
        )
        try:
            dispatch_args = unmask_pii_in_args(args, state.pii_token_map)
            outcome = await dispatch_tool(
                tool_name=tool_name,
                args=dispatch_args,
                work_item_id=run_ctx.get("work_item_id")
                or run_ctx.get("workItemId"),
                workspace_id=run_ctx.get("workspace_id")
                or run_ctx.get("workspaceId"),
                run_context=run_context,
                bearer=bearer,
                laptop_user_id=laptop_user_id,
            )
            # M75 Slice 5 — read provenance off the dispatch result.
            # Pre-Slice-5 ToolDispatchResult instances (defensive)
            # default served_by="http" via the dataclass — so getattr
            # is just extra safety for any monkeypatched fake in old
            # tests that builds the dataclass without keyword args.
            outcome_served_by = getattr(outcome, "served_by", "http")
            outcome_laptop_device_id = getattr(outcome, "laptop_device_id", None)
            outcome_laptop_device_name = getattr(outcome, "laptop_device_name", None)
            masked_result, new_token_map, mask_applied = mask_pii_in_result(
                outcome.result, state.pii_token_map,
            )
            # PhaseState is frozen; update via dataclasses.replace so the
            # subsequent tool call in this turn (if any) sees the new
            # token map. Token map accumulates across every tool call —
            # not gated by phase advance — so we update `state` here
            # rather than waiting for advance_phase. Pause/resume picks
            # up the latest via PhaseState.to_dict.
            if new_token_map != state.pii_token_map:
                state = replace(state, pii_token_map=new_token_map)
                result.next_state = state

            # Code-review fix #4 (2026-05-23) — server-side cap on
            # per-tool result size. Without this an agent can `read_file`
            # an entire monorepo and blow its context window in one
            # call. policy.context_policy.max_chars_per_read sets the
            # ceiling; results that exceed it get truncated + an audit
            # event fires so operators see the overflow. Truncation is
            # the right knob (vs hard refuse) because most read tools
            # don't surface a length kwarg the gateway could enforce
            # before dispatch — truncating the result has the same
            # structural effect (the agent can't see more than the cap)
            # without breaking any tool's contract.
            max_chars = None
            ctx_policy = policy.context_policy if policy else None
            if isinstance(ctx_policy, dict):
                raw_cap = ctx_policy.get("max_chars_per_read")
                if isinstance(raw_cap, int) and raw_cap > 0:
                    max_chars = raw_cap
            if max_chars is not None:
                outcome_result, truncated_bytes = _truncate_oversize_strings(
                    outcome.result, max_chars,
                )
                if truncated_bytes > 0:
                    # Mutate the outcome's result; the mask + state
                    # update below sees the trimmed value, so the
                    # truncation propagates into history.
                    outcome = ToolDispatchResult(
                        result=outcome_result,
                        duration_ms=outcome.duration_ms,
                        tool_invocation_id=outcome.tool_invocation_id,
                        tool_success=outcome.tool_success,
                        tool_error=outcome.tool_error,
                        served_by=outcome.served_by,
                        laptop_device_id=outcome.laptop_device_id,
                        laptop_device_name=outcome.laptop_device_name,
                    )
                    await emit_governed_event(
                        kind="governed.read_truncated",
                        state=state,
                        policy=policy,
                        run_context=run_context,
                        payload={
                            "tool_name": tool_name,
                            "max_chars_per_read": max_chars,
                            "truncated_bytes": truncated_bytes,
                            "tool_invocation_id": outcome.tool_invocation_id,
                        },
                        severity="warn",
                    )

            # Code-review fix #2 (2026-05-23) — EditReceipt provenance
            # binding. When a mutating tool (apply_patch / replace_text /
            # create_file / write_file / finish_work_branch) succeeds it
            # returns a result envelope carrying a code_change_id and
            # the file path it touched. Accumulate those into PhaseState
            # so the ACT→VERIFY EditReceipt validator can check that
            # every claimed edit has a backing tool dispatch (closes
            # the "self-declared receipt" loophole).
            new_changes = _extract_code_changes(
                tool_name=tool_name,
                result=outcome.result,
                tool_success=outcome.tool_success,
            )
            if new_changes:
                merged = {
                    k: list(v) for k, v in state.produced_code_changes.items()
                }
                for file_path, change_id in new_changes:
                    merged.setdefault(file_path, []).append(change_id)
                state = replace(state, produced_code_changes=merged)
                result.next_state = state
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=tool_name,
                    phase=state.current_phase.value,
                    allowed=True,
                    args=args,
                    result=masked_result,
                    duration_ms=outcome.duration_ms,
                    tool_invocation_id=outcome.tool_invocation_id,
                    tool_success=outcome.tool_success,
                    tool_error=outcome.tool_error,
                )
            )
            # M75 Slice 5 — provenance on every tool_dispatched event so
            # operators can filter "all laptop activity for this stage"
            # via a single audit-gov query. The dedicated
            # tool_dispatched_via_laptop event below stays as a separate
            # kind because the workgraph-api insights router buckets
            # those into per-node laptop badges (it doesn't read
            # payload.served_by — the kind IS the filter).
            await emit_governed_event(
                kind="governed.tool_dispatched",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "tool_name": tool_name,
                    "tool_invocation_id": outcome.tool_invocation_id,
                    "duration_ms": outcome.duration_ms,
                    "tool_success": outcome.tool_success,
                    "served_by": outcome_served_by,
                    "laptop_device_id": outcome_laptop_device_id,
                    "laptop_device_name": outcome_laptop_device_name,
                },
            )
            # M75 Slice 5 — emit the per-tool laptop badge event when
            # the bridge handled the call. workgraph-api's insights
            # router (insights.router.ts) aggregates these into a
            # per-node "🖥 served by your laptop ({device})" badge,
            # giving operators the same visibility the legacy
            # cf.invoke.via_laptop per-invoke event provided — at the
            # finer per-tool granularity the new path naturally
            # produces. Device fields stay top-level (matches the
            # legacy event shape) so the insights router needs no
            # special-case parsing.
            if outcome_served_by == "laptop" and outcome_laptop_device_id:
                await emit_governed_event(
                    kind="governed.tool_dispatched_via_laptop",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload={
                        "tool_name": tool_name,
                        "tool_invocation_id": outcome.tool_invocation_id,
                        "duration_ms": outcome.duration_ms,
                        "user_id": ctx_user_id,
                        "device_id": outcome_laptop_device_id,
                        "device_name": outcome_laptop_device_name,
                        "workflow_instance_id": run_ctx.get("workflow_instance_id")
                        or run_ctx.get("workflowInstanceId"),
                        "workflow_node_id": run_ctx.get("workflow_node_id")
                        or run_ctx.get("workflowNodeId"),
                    },
                )
            if mask_applied:
                # M73-followup #93 — separate audit event so operators
                # can search "show me every tool call that masked PII
                # this run". Counts only, no values — value-bearing
                # data stays in PhaseState.pii_token_map (deleted with
                # the session) and never enters audit-gov.
                await emit_governed_event(
                    kind="governed.pii_masked",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload={
                        "tool_name": tool_name,
                        "tool_invocation_id": outcome.tool_invocation_id,
                        "kinds": [
                            {"kind": e["kind"], "count": e["count"]}
                            for e in mask_applied
                        ],
                        "token_map_size": len(new_token_map),
                    },
                )
        except ToolDispatchError as exc:
            log.warning("tool dispatch failed tool=%s err=%s", tool_name, exc)
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=tool_name,
                    phase=state.current_phase.value,
                    allowed=True,
                    args=args,
                    dispatch_error=str(exc),
                )
            )
            await emit_governed_event(
                kind="governed.tool_dispatch_failed",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={"tool_name": tool_name, "error": str(exc)},
                severity="warn",
            )

    # ── 2. Phase output validation + advance ──────────────────────────────

    if phase_output is not None:
        try:
            receipt = validate_phase_output(state.current_phase, phase_output, policy=policy)
        except PhaseOutputInvalid as exc:
            log.info(
                "phase output invalid phase=%s details=%d",
                state.current_phase.value,
                len(exc.details),
            )
            result.validation_error = exc.to_dict()
            await emit_governed_event(
                kind="governed.phase_output_invalid",
                state=state,
                policy=policy,
                run_context=run_context,
                payload=exc.to_dict(),
                severity="warn",
            )
            return result

        result.receipt = receipt

        # M74 Phase 1B — path-coverage check at ACT → VERIFY (and ACT → REPAIR,
        # since both transitions imply "we're done editing this round"). Refuse
        # the advance when the EditReceipt doesn't structurally cover the
        # PlanReceipt.target_files AND the agent didn't declare them skipped.
        # The check is a no-op when there's no prior plan or the plan had no
        # target_files.
        if (
            state.current_phase is Phase.ACT
            and next_phase is not None
            and isinstance(receipt, dict)
            and receipt.get("kind") == "edit_receipt"
        ):
            plan_receipts = state.receipts.get(Phase.PLAN.value) or []
            latest_plan = plan_receipts[-1] if plan_receipts else None
            gap = check_path_coverage(latest_plan, receipt)
            if gap is not None:
                log.info(
                    "path coverage gap phase=ACT uncovered=%d",
                    len(gap.uncovered),
                )
                result.validation_error = gap.as_error_payload()
                await emit_governed_event(
                    kind="governed.path_coverage_gap",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload=gap.as_error_payload(),
                    severity="warn",
                )
                return result

            # Code-review fix #2 (2026-05-23) — EditReceipt provenance.
            # Cross-check that every file the receipt claims to have
            # edited has at least one backing code_change_id from a
            # real mutating-tool dispatch (accumulated on
            # state.produced_code_changes across all turns of the
            # stage). Closes the loophole where an agent could submit
            # `{file: "foo.py", edit_type: "apply_patch"}` without
            # ever actually calling apply_patch.
            unbacked = _check_edit_receipt_provenance(
                receipt=receipt,
                produced_changes=state.produced_code_changes,
            )
            if unbacked:
                err_payload = {
                    "error_code": "PHASE_EDIT_UNBACKED",
                    "phase": "ACT",
                    "reason": (
                        f"EditReceipt claims edits on file(s) {unbacked!r} "
                        "but no successful mutating-tool dispatch produced "
                        "a code_change_id for them in this stage. Either "
                        "actually dispatch the mutating tool, or remove "
                        "the file from edits[]."
                    ),
                    "unbacked_files": unbacked,
                }
                result.validation_error = err_payload
                await emit_governed_event(
                    kind="governed.edit_receipt_unbacked",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload=err_payload,
                    severity="warn",
                )
                return result

            # M74 Phase 1A — auto-verify on mutation. After ACT produces an
            # EditReceipt and coverage is satisfied, run a verifier on the
            # agent's behalf before letting VERIFY proceed. The result is
            # rendered as a system-injected user message in the next turn's
            # prompt by stage_driver. Failure modes are non-blocking — the
            # synthesis returns SyntheticVerifierResult(kind="skipped" |
            # "unavailable") rather than raising, so the stage continues
            # but the agent sees an honest record of what the orchestrator
            # tried.
            try:
                synth = await synthesize_verifier_run(
                    receipt,
                    work_item_id=(run_context or {}).get("work_item_id")
                    or (run_context or {}).get("workItemId"),
                    workspace_id=(run_context or {}).get("workspace_id")
                    or (run_context or {}).get("workspaceId"),
                    run_context=run_context,
                    bearer=bearer,
                )
                result.synthetic_verifier = synth.to_dict()
                await emit_governed_event(
                    kind="governed.auto_verify_completed",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload=synth.to_dict(),
                    severity="info" if synth.kind == "ran" and synth.tool_success else "warn",
                )
            except Exception as exc:  # pylint: disable=broad-except
                # synthesize_verifier_run is documented as never-raising;
                # this is purely defensive against future refactors.
                log.warning("auto-verify swallowed unexpected error: %s", exc)
                result.synthetic_verifier = {
                    "kind": "unavailable",
                    "reason": f"orchestrator error: {exc!s}",
                }

        # Code-review fix #6 (2026-05-23) — gate VERIFY → SELF_REVIEW on
        # an actually-passing verification. The Phase 1C validator already
        # requires `reason` for status='unavailable', but nothing in the
        # phase machine blocked an unverified stage from sliding to
        # SELF_REVIEW — operators caught it manually or not at all.
        #
        # New rule: when transitioning VERIFY → SELF_REVIEW, the
        # VerificationReceipt's status MUST be 'passed' unless the
        # stage's risk_policy.allow_unverified is True (explicit
        # operator opt-out for stages that have no verifier — e.g. pure
        # documentation edits).
        if (
            state.current_phase is Phase.VERIFY
            and next_phase is Phase.SELF_REVIEW
            and isinstance(receipt, dict)
            and receipt.get("kind") == "verification_receipt"
        ):
            allow_unverified = bool(
                (policy.risk_policy or {}).get("allow_unverified", False)
            )
            verify_payload = receipt.get("verification_result") or {}
            status = (
                verify_payload.get("status")
                if isinstance(verify_payload, dict)
                else None
            )
            if not allow_unverified and status != "passed":
                err_payload = {
                    "error_code": "PHASE_VERIFY_NOT_PASSED",
                    "phase": "VERIFY",
                    "reason": (
                        f"VerificationReceipt.status={status!r} cannot "
                        "advance to SELF_REVIEW. Either: (a) advance to "
                        "REPAIR and fix the verifier output, or (b) set "
                        "risk_policy.allow_unverified=true on the stage "
                        "policy if this stage legitimately has nothing "
                        "to verify."
                    ),
                    "status": status,
                    "allow_unverified": allow_unverified,
                }
                result.validation_error = err_payload
                await emit_governed_event(
                    kind="governed.verify_not_passed",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload=err_payload,
                    severity="warn",
                )
                return result

        if next_phase is not None:
            try:
                new_state = advance_phase(
                    state,
                    next_phase,
                    receipt=receipt,
                    max_repair_attempts=policy.max_repair_attempts,
                    max_plan_rewinds=policy.max_plan_rewinds,
                )
            except ValueError as exc:
                # Illegal transition or repair cap exceeded. Don't advance;
                # surface to caller so they can branch (BLOCKED stage, etc.).
                result.validation_error = {
                    "error_code": "PHASE_TRANSITION_REFUSED",
                    "phase": state.current_phase.value,
                    "reason": str(exc),
                }
                await emit_governed_event(
                    kind="governed.phase_transition_refused",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload={"reason": str(exc), "attempted_next": next_phase.value},
                    severity="warn",
                )
                return result

            result.next_state = new_state
            result.to_phase = new_state.current_phase.value
            result.phase_advanced = new_state.current_phase is not state.current_phase
            await emit_governed_event(
                kind="governed.phase_completed",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "from_phase": state.current_phase.value,
                    "to_phase": new_state.current_phase.value,
                    "receipt_kind": receipt.get("kind"),
                    "approval_pending": new_state.approval_pending,
                },
            )

    return result
