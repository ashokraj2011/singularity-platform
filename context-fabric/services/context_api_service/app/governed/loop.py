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

import asyncio
import logging
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from .audit_emit import emit_governed_event
from .dispatch import ToolDispatchError, ToolDispatchResult, dispatch_tool
from .path_coverage import check_path_coverage
from .phase_state import Phase, PhaseState, advance_phase
from .pii_mask import mask_pii_in_result, unmask_pii_in_args

# Source-code file extensions whose content must NOT be PII-masked before
# returning to the LLM. Test fixtures routinely contain email-like strings
# (e.g. "user42@example.com" in a regex test) that the email detector fires
# on, corrupting the exact lines the agent needs to read in order to repair
# a failing test. Source code is not personal data; masking it is a false
# positive with serious downstream consequences (M76 postmortem).
_SOURCE_CODE_EXTS = frozenset(
    ".java .py .ts .tsx .js .jsx .go .rs .kt .scala .rb .cs .cpp .c .h .swift".split()
)

# M83.x parallel exploration — tools that are safe to dispatch in
# parallel within a single LLM turn. The hard rule: must be read-only
# (no filesystem mutation, no git side-effects, no shell execution
# against the workspace). EXPLORE-phase tools dominate this list since
# that's where parallelism pays. Adding to this list requires:
#   1. No mutation of workspace state or git refs.
#   2. No execution of arbitrary user-controlled commands (run_test,
#      finish_work_branch, etc. stay sequential even if the underlying
#      runner happens to be idempotent today).
#   3. Idempotent — same args MUST return the same result if nothing
#      else changed.
_PARALLEL_SAFE_TOOLS = frozenset({
    "repo_map",
    "symbol_search",
    "list_files",
    "list_directory",
    "read_file",
    "read_files",
    "read_repo_instructions",
    "read_workitem",
    "code_context_package",
    "ast_search",
    "grep",
    "search_code",
})

# Concurrency cap on the parallel dispatch group. Sized to balance
# wall-clock win (large enough to mask mcp-server's ~30-80ms per-call
# overhead on warm tool runners) against the workspace runner pool
# size (mcp-sandbox-runner serves dispatches; flooding it with 20
# concurrent reads serializes anyway at the container side). 6 is the
# sweet spot empirically: 90% of the theoretical parallel speedup
# without thrashing the runner.
_PARALLEL_DISPATCH_CONCURRENCY = 6
from .verify_synthesis import synthesize_verifier_run
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
from .tool_gateway import PhaseToolForbidden, check_tool_allowed
from .validators import (
    PhaseOutputInvalid,
    check_context_receipt_substance,
    validate_phase_output,
)
from .baseline_diff import (
    enrich_verification_receipt,
    extract_failing_tests_from_tool_output,
    stash_baseline,
)

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
    # M95 — set when a PLAN receipt declared actionable != "yes" (the
    # premise is already satisfied / blocked). Carries {actionable,
    # reason, evidence}. stage_driver halts the stage as NOT_ACTIONABLE
    # so it surfaces to the human-confirmation gate instead of forcing
    # fabricated ACT work. None on normal turns.
    not_actionable: dict[str, Any] | None = None

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
            "not_actionable": self.not_actionable,
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
    tool_invocation_id: str | None = None,
) -> list[tuple[str, str]]:
    """Pull (file_path, change_id) pairs from a successful mutating
    tool's result envelope. Returns [] when the tool isn't mutating,
    didn't succeed, or didn't surface a recognisable file path.

    Recognised aliases on the result dict:
      - paths_touched / paths_changed / changed_files / files — list-shape
        (mcp-server's apply_patch / replace_text / write_file all emit
        `paths_touched`; older variants used the plural `files`).
      - file / path / file_path / target_file — single-shape.
      - code_change_id / codeChangeId / changeId / change_id — the
        binding token; when absent we fall back to the tool_invocation_id
        which the loop generates per dispatch and which is unique per
        tool call. The binding token's purpose is to PROVE the dispatch
        happened — tool_invocation_id satisfies that contract just as
        well as a server-minted change_id.

    Returns a list of `(path, change_id)` tuples; one per file the tool
    reported as touched. Empty list = nothing to bind (path or
    invocation_id missing).

    (2026-05-25) RCA: mcp-server's mutating-tool output uses
    `paths_touched` and does NOT include a `code_change_id`. The
    previous version of this function required both a recognized path
    key (which `paths_touched` wasn't) AND a `code_change_id` (never
    emitted) — so every successful mutation looked unbacked to the
    receipt-provenance check, causing PHASE_EDIT_UNBACKED to fire
    on legitimate edits. Adding `paths_touched` to the alias list +
    falling back to tool_invocation_id closes both gaps.
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
        # When the tool doesn't mint a change_id, the dispatch's
        # invocation id is a perfectly stable binding token — every
        # tool call has one and it ties the EditReceipt claim back to
        # the audit-gov `governed.tool_dispatched` event for the call.
        or tool_invocation_id
    )
    if not isinstance(change_id, str) or not change_id:
        return []

    # Pull the file path(s). Try BATCH shape first because that's what
    # mcp-server actually emits (paths_touched is the canonical key).
    paths: list[str] = []
    for batch_key in ("paths_touched", "paths_changed", "changed_files", "files"):
        batch = result.get(batch_key)
        if isinstance(batch, list):
            paths.extend(p for p in batch if isinstance(p, str) and p.strip())
    # Single-file shape as fallback (some tools emit just `file`/`path`).
    single = (
        result.get("file")
        or result.get("path")
        or result.get("file_path")
        or result.get("target_file")
    )
    if isinstance(single, str) and single.strip():
        paths.append(single)

    if not paths:
        return []
    # Dedupe while preserving order in case the tool reports the same
    # path twice across batch + single shapes.
    seen: set[str] = set()
    deduped: list[str] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            deduped.append(p)
    return [(_normalise_change_path(p), change_id) for p in deduped]


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
    #
    # M83.x parallel exploration — tool dispatch happens in two passes:
    #
    #   Pass A (pre-classify, sequential): for every tool_call we run the
    #   normalize + policy gate. Malformed/refused calls get their
    #   outcomes recorded immediately and their audit events fired in
    #   submission order so audit-gov shows the same picture as before.
    #   Allowed calls get queued in `allowed_queue` for Pass B.
    #
    #   Pass B (dispatch + post-process): allowed calls whose tool_name
    #   is in _PARALLEL_SAFE_TOOLS get dispatched concurrently via
    #   asyncio.gather (capped by _PARALLEL_DISPATCH_CONCURRENCY). The
    #   rest dispatch sequentially. Post-dispatch processing (PII
    #   masking, result truncation, code-change extraction, audit
    #   event emission) ALWAYS happens in submission order and on the
    #   running `state` so state mutations stay deterministic.
    #
    # Why pass B can't just gather everything: pii_token_map and
    # produced_code_changes need to thread sequentially through every
    # allowed call (so token IDs stay stable and EditReceipt provenance
    # is bound to the right tool). Parallel-safe tools (reads, ast,
    # repo_map) don't produce code changes and source-code reads bypass
    # PII masking entirely (see _skip_mask), so dispatching them with a
    # snapshot of the token map is harmless.
    allowed_queue: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
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

        # M83.x — defer the actual dispatch to Pass B; allowed_queue
        # preserves submission order so post-dispatch processing stays
        # deterministic. Pass B then concurrently dispatches the
        # parallel-safe subset.
        allowed_queue.append((raw, tool_name, args))

    # ── Pass B: dispatch (concurrent for parallel-safe, sequential rest)
    # and post-process. State mutations thread through this loop in
    # submission order so EditReceipt provenance + pii_token_map remain
    # deterministic across re-runs.
    #
    # Pre-dispatch the parallel-safe calls via gather BEFORE entering the
    # post-process loop. Each parallel call uses a snapshot of the
    # current pii_token_map for arg unmasking — they can't see each
    # other's token-map mutations, but the allowlist is restricted to
    # read-only tools (mostly source-code reads, which skip masking
    # entirely), so the practical impact is nil.
    pre_dispatched: dict[int, ToolDispatchResult | Exception] = {}
    if allowed_queue:
        parallel_indices = [
            i for i, (_, name, _) in enumerate(allowed_queue)
            if name in _PARALLEL_SAFE_TOOLS
        ]
        if len(parallel_indices) >= 2:
            # Only gather when there's actual parallelism to win. A
            # single parallel-safe call just goes through the sequential
            # path with one fewer indirection.
            snapshot_token_map = dict(state.pii_token_map)
            run_ctx_for_gather = run_context or {}
            prefer_laptop_g = run_ctx_for_gather.get("prefer_laptop")
            ctx_user_id_g = (
                run_ctx_for_gather.get("user_id")
                or run_ctx_for_gather.get("userId")
            )
            laptop_user_id_g = (
                str(ctx_user_id_g)
                if prefer_laptop_g is True and ctx_user_id_g
                else None
            )
            semaphore = asyncio.Semaphore(_PARALLEL_DISPATCH_CONCURRENCY)

            async def _bounded(i: int) -> ToolDispatchResult:
                _, tname, targs = allowed_queue[i]
                async with semaphore:
                    return await dispatch_tool(
                        tool_name=tname,
                        args=unmask_pii_in_args(targs, snapshot_token_map),
                        work_item_id=run_ctx_for_gather.get("work_item_id")
                        or run_ctx_for_gather.get("workItemId"),
                        workspace_id=run_ctx_for_gather.get("workspace_id")
                        or run_ctx_for_gather.get("workspaceId"),
                        run_context=run_context,
                        bearer=bearer,
                        laptop_user_id=laptop_user_id_g,
                    )

            gather_results = await asyncio.gather(
                *[_bounded(i) for i in parallel_indices],
                return_exceptions=True,
            )
            for i, res in zip(parallel_indices, gather_results):
                pre_dispatched[i] = res
            log.info(
                "parallel tool dispatch phase=%s count=%d concurrency=%d",
                state.current_phase.value,
                len(parallel_indices),
                _PARALLEL_DISPATCH_CONCURRENCY,
            )

    for queue_idx, (raw, tool_name, args) in enumerate(allowed_queue):
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
            # M83.x — if this call was pre-dispatched in the parallel
            # gather, surface the cached result (or re-raise the
            # captured exception) rather than calling dispatch_tool
            # again. dispatch_args still gets computed for the audit
            # event payload + downstream code-change extraction logic
            # that reads from `dispatch_args`.
            dispatch_args = unmask_pii_in_args(args, state.pii_token_map)
            pre = pre_dispatched.get(queue_idx)
            if pre is not None:
                if isinstance(pre, BaseException):
                    raise pre
                outcome = pre
            else:
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
            # M90.A — Baseline test-failure capture. When the agent
            # dispatches capture_test_baseline (per M70.4) and the tool
            # succeeds, extract the failingTests set from the parsed
            # output and stash it on state.receipts so the post-edit
            # VerificationReceipt can be diffed against it (mirrors
            # legacy invoke.ts:enrichWithBaselineDiff). We read the
            # RAW outcome.result here BEFORE PII masking — failing
            # test names like `org.foo.Bar.testBaz` aren't PII and we
            # want a stable signature for diffing. Idempotent: only
            # the first baseline of a stage is kept.
            if (
                tool_name == "capture_test_baseline"
                and getattr(outcome, "tool_success", False)
            ):
                _bfail, _btotal = extract_failing_tests_from_tool_output(outcome.result)
                stash_baseline(
                    state.receipts,
                    _bfail,
                    _btotal,
                    command=str(dispatch_args.get("command") or ""),
                )
                log.info(
                    "baseline_diff: captured baseline failing=%d total=%s",
                    len(_bfail), _btotal,
                )

            # M75 Slice 5 — read provenance off the dispatch result.
            # Pre-Slice-5 ToolDispatchResult instances (defensive)
            # default served_by="http" via the dataclass — so getattr
            # is just extra safety for any monkeypatched fake in old
            # tests that builds the dataclass without keyword args.
            outcome_served_by = getattr(outcome, "served_by", "http")
            outcome_laptop_device_id = getattr(outcome, "laptop_device_id", None)
            outcome_laptop_device_name = getattr(outcome, "laptop_device_name", None)
            # Skip PII masking for source-code file reads. Test fixtures
            # contain email-shaped strings that are fixture data, not real
            # PII. Masking them corrupts the content the agent reads and
            # causes it to apply wrong repairs (M76 postmortem, fix #3).
            _read_path: str = ""
            if tool_name == "read_file":
                _read_path = str(
                    dispatch_args.get("path")
                    or dispatch_args.get("file_path")
                    or dispatch_args.get("filePath")
                    or ""
                )
            _skip_mask = tool_name == "read_file" and any(
                _read_path.endswith(ext) for ext in _SOURCE_CODE_EXTS
            )
            if _skip_mask:
                masked_result = outcome.result
                new_token_map = state.pii_token_map
                mask_applied: list = []
            else:
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

            # M90.F (2026-05-27) — soft large-file-read warning. The
            # StagePolicy.context_policy.large_file_threshold_lines field
            # existed in seeds (DEVELOP=500) but was never consumed. Now:
            # when a read_file dispatch returns a result that exceeds the
            # threshold (counted by '\n' chars), we emit a
            # governed.large_file_read audit event with the line count and
            # the policy guidance. Soft enforcement (no refusal) — the
            # agent still gets the content, but operators reviewing the
            # audit trail can see when the agent is repeatedly reading
            # huge files instead of using get_ast_slice. Pairs with
            # ast_first policy guidance once it's wired into the prompts.
            if (
                tool_name == "read_file"
                and outcome.tool_success
                and isinstance(ctx_policy, dict)
            ):
                _raw_threshold = ctx_policy.get("large_file_threshold_lines")
                if isinstance(_raw_threshold, int) and _raw_threshold > 0:
                    # Count newlines in any string field of the result.
                    # The mcp-server read_file response shape is roughly
                    # {content: "..."} or {text: "..."} depending on
                    # version; handle both lenient.
                    _result_text = ""
                    if isinstance(outcome.result, dict):
                        _result_text = (
                            outcome.result.get("content")
                            or outcome.result.get("text")
                            or outcome.result.get("body")
                            or ""
                        )
                    elif isinstance(outcome.result, str):
                        _result_text = outcome.result
                    if isinstance(_result_text, str) and _result_text:
                        _line_count = _result_text.count("\n") + 1
                        if _line_count > _raw_threshold:
                            await emit_governed_event(
                                kind="governed.large_file_read",
                                state=state,
                                policy=policy,
                                run_context=run_context,
                                payload={
                                    "tool_name": tool_name,
                                    "path": _read_path or "<unknown>",
                                    "line_count": _line_count,
                                    "threshold_lines": _raw_threshold,
                                    "ast_first_policy": bool(ctx_policy.get("ast_first")),
                                    "tool_invocation_id": outcome.tool_invocation_id,
                                },
                                severity="info",
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
                # (2026-05-25) Fallback binding token when the tool
                # didn't mint a code_change_id of its own. Every
                # dispatch has an invocation id; using it here lets
                # the EditReceipt-provenance check accept the edit.
                tool_invocation_id=outcome.tool_invocation_id,
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
            # M87 — pass state so REPAIR can auto-fill retry_number +
            # failure_summary from server-side data instead of failing
            # validation on fields the platform already knows.
            receipt = validate_phase_output(
                state.current_phase, phase_output, policy=policy, state=state
            )
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

        # M90.A — Enrich VerificationReceipts with baseline diff.
        # When a capture_test_baseline was dispatched earlier in the
        # stage, the stash contains the pre-edit failing-test set.
        # Computing the diff here gives the downstream approval gate
        # (blueprint.router.ts:5860) the same baseline_diff +
        # effective_passed signals the legacy MCP loop produced —
        # pre-existing failures stop blocking approval.
        if (
            isinstance(receipt, dict)
            and receipt.get("kind") == "verification_receipt"
        ):
            receipt = enrich_verification_receipt(receipt, state.receipts)

        result.receipt = receipt

        # M95 (2026-05-28) — Not-actionable / no-op short-circuit.
        # When the PLAN phase declares actionable != "yes" (the premise is
        # already satisfied, or it's blocked), DON'T march the agent into
        # ACT/VERIFY — that would force fabricated edits (EditReceipt.edits
        # has min_length=1) or bounce on PHASE_EDIT_UNBACKED. Instead emit a
        # governed.story_no_op event (severity info — a legitimate terminal,
        # not an error) and flag the result so stage_driver halts the stage
        # as NOT_ACTIONABLE, surfacing to the human-confirmation gate with
        # the agent's reason + evidence. The receipt's own model validator
        # (M95.1) already guaranteed both are present.
        if (
            state.current_phase is Phase.PLAN
            and isinstance(receipt, dict)
            and receipt.get("kind") == "plan_receipt"
            and str(receipt.get("actionable") or "yes") != "yes"
        ):
            verdict = str(receipt.get("actionable"))
            result.not_actionable = {
                "actionable": verdict,
                "reason": receipt.get("not_actionable_reason"),
                "evidence": receipt.get("not_actionable_evidence"),
            }
            log.info(
                "story not actionable phase=PLAN stage=%s verdict=%s",
                state.stage_key, verdict,
            )
            await emit_governed_event(
                kind="governed.story_no_op",
                state=state,
                policy=policy,
                run_context=run_context,
                payload=result.not_actionable,
                severity="info",
            )
            # Do not advance the phase. The stage halts here; the human gate
            # confirms (or overrides) the no-op verdict.
            return result

        # M92.C (2026-05-27) — require_context_receipt enforcement.
        # When the stage policy declares `context_policy.require_context_receipt`
        # true, an EXPLORE-phase submission must carry real evidence
        # (≥1 context_used entry or ≥1 implementation_finding). Pre-M92.C
        # the flag was seeded but unread: every default-empty ContextReceipt
        # passed Pydantic and the agent jumped EXPLORE→ACT having
        # demonstrated zero exploration. Now we surface a structured
        # validation error so the LLM gets a recoverable bounce ("populate
        # context_used or implementation_findings") rather than silently
        # advancing.
        if (
            state.current_phase is Phase.EXPLORE
            and next_phase is not None
            and isinstance(receipt, dict)
        ):
            ctx_issues = check_context_receipt_substance(receipt, policy)
            if ctx_issues is not None:
                log.info(
                    "context receipt insubstantial phase=EXPLORE stage=%s",
                    state.stage_key,
                )
                err_payload = {
                    "error_code": "CONTEXT_RECEIPT_EMPTY",
                    "phase": Phase.EXPLORE.value,
                    "reason": (
                        "context_policy.require_context_receipt is enabled for "
                        "this stage and the ContextReceipt has no substantive "
                        "evidence of exploration. Add at least one context_used "
                        "entry (the repo_map / symbol / file you read) or one "
                        "implementation_finding, then re-submit EXPLORE."
                    ),
                    "details": ctx_issues,
                }
                result.validation_error = err_payload
                await emit_governed_event(
                    kind="governed.context_receipt_empty",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload=err_payload,
                    severity="warn",
                )
                return result

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
                # (2026-05-25) Self-correction guidance.
                # The model's go-to mistake on this error is to retry with
                # the SAME EditReceipt and HOPE — burning turns. Tell it
                # exactly what to do: move the unbacked file(s) to
                # skipped_targets[] with a reason. This nudges the model
                # toward the correct receipt shape on its very next turn
                # instead of falling back to "re-edit and hope".
                unbacked_list = ", ".join(f'"{p}"' for p in unbacked)
                skip_entries = ", ".join(
                    f'{{file: "{p}", reason: "<one-sentence reason, e.g. no edit required after implementing X>"}}'
                    for p in unbacked
                )
                err_payload = {
                    "error_code": "PHASE_EDIT_UNBACKED",
                    "phase": "ACT",
                    "reason": (
                        f"EditReceipt claims edits on file(s) [{unbacked_list}] "
                        "but no successful mutating-tool dispatch produced "
                        "a code_change_id for them in this stage. To self-"
                        "correct on the next turn, do EXACTLY ONE of: "
                        f"(A) REMOVE those files from edits[] AND ADD them "
                        f"to skipped_targets[] like this: skipped_targets: "
                        f"[{skip_entries}]; "
                        "OR (B) actually dispatch the mutating tool "
                        "(apply_patch / replace_text / replace_range / "
                        "write_file / create_file) for each file BEFORE "
                        "the next submit_phase_output. Do NOT just resubmit "
                        "the same EditReceipt — the provenance check is "
                        "deterministic; it will fail the same way until "
                        "edits[] only lists files you actually mutated."
                    ),
                    "unbacked_files": unbacked,
                    "self_correction_hint": "MOVE_TO_SKIPPED_TARGETS",
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
