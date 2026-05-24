"""
M71 Slice C(b) — Single-turn LLM driver.

Wires the resolved per-phase prompt, the LLM gateway, and the governance
oracle (`loop.governed_step`) into ONE round trip:

    workgraph-api / Workbench
        │
        v
    POST /api/v1/execute-governed-turn
        │
        v  context-fabric
        │   1. load StagePolicy
        │   2. resolve per-phase prompt (prompt-composer)
        │   3. build LLM messages + tool descriptors
        │   4. POST llm-gateway /v1/chat/completions
        │   5. parse tool_calls + extract submit_phase_output meta-call
        │   6. governed_step() — hard-refuse, dispatch, validate, advance
        │   7. return {next_state, llm_response_meta, step_result}
        │
        v
    caller persists next_state, decides whether to call again

The LLM signals phase completion by invoking a synthetic meta-tool called
`submit_phase_output` with `{payload, next_phase}` arguments. The turn
loop intercepts it (it never reaches mcp-server) and routes the payload
through the receipt validator + state machine. Every other tool call goes
through the policy gateway and onto /mcp/tool-run as usual.

This is the SINGLE-TURN form. Multi-turn (keep calling until phase
advances or we hit max_turns) is C(b2) — sketched out in `run_phase()`
below but not exposed via HTTP yet.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from .audit_emit import emit_governed_event
from .llm_client import ChatResponse, ChatToolCall, LLMGatewayError, call_gateway_chat
from .code_context import (
    build_code_context_for_governed_turn,
    package_markdown,
)
from .loop import GovernedStepResult, governed_step
from .phase_state import Phase, PhaseState
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
from .prompt_safety import safen_history
from .prompt_resolver import (
    PromptNotFoundError,
    ResolvedPrompt,
    resolve_phase_prompt,
)
from .tool_gateway import allowed_tools_for

log = logging.getLogger(__name__)


# Synthetic meta-tool the LLM calls to submit its phase output + declare
# the next phase. NEVER dispatched to mcp-server. The loop catches the call
# by name and routes the payload through the receipt validator.
SUBMIT_PHASE_OUTPUT = "submit_phase_output"


@dataclass
class TurnResult:
    """One LLM turn's outcome. Returned by `/api/v1/execute-governed-turn`."""

    # Phase state after the turn — caller persists this.
    next_state: PhaseState
    # Governance-oracle result (tool outcomes, validation errors, etc.).
    step: GovernedStepResult
    # LLM response meta (no token-by-token content; just usage + finish_reason).
    llm: dict[str, Any]
    # Which prompt binding fired (binding_id + phase_used). Operators rely
    # on this to debug "why did the agent get the wrong instructions".
    prompt: dict[str, Any]
    # Resolved policy summary so the caller doesn't have to fetch it separately.
    policy: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "next_state": self.next_state.to_dict(),
            "step": self.step.to_dict(),
            "llm": self.llm,
            "prompt": self.prompt,
            "policy": self.policy,
        }


def _build_messages(prompt: ResolvedPrompt, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compose the OpenAI-style message list the gateway expects.

    System message = prompt.system_prompt_append.
    User message   = prompt.task + (extra_context if any).
    History       = optional list of prior {role, content, tool_calls, tool_call_id}
                    entries from earlier turns this phase. Empty on the first turn.

    M74 Phase 3B — tool-role messages in history are wrapped in
    `<tool_result>...</tool_result>` delimiters via safen_history before
    they reach the model. This defends against the basic
    prompt-injection-via-tool-output attack class (a fetched README
    containing "Ignore previous instructions" no longer parses as a
    command to the model). The wrap is applied here, not at history
    accumulation time, so stage_driver's bookkeeping (compression,
    persistence) operates on the un-wrapped messages.
    """
    messages: list[dict[str, Any]] = []
    if prompt.system_prompt_append.strip():
        messages.append({"role": "system", "content": prompt.system_prompt_append})
    body = prompt.task
    if prompt.extra_context.strip():
        body = f"{body}\n\n{prompt.extra_context}"
    if body:
        messages.append({"role": "user", "content": body})
    messages.extend(safen_history(history))
    return messages


def _build_tool_descriptors(policy: StagePolicy, phase: Phase) -> list[dict[str, Any]]:
    """Tool descriptors handed to the LLM.

    M72 Slice A — Cache-stable variant. The descriptor list is now the UNION
    of every tool across all phases of the stage's StagePolicy. Each tool
    carries a `phase_scope` hint in its description so the LLM can avoid
    out-of-phase calls without us having to filter the tool list per turn.
    The hard-refuse path (`tool_gateway.check_tool_allowed`) still catches
    any actual out-of-phase dispatch server-side — we just stop invalidating
    the LLM-provider prompt-cache prefix every time we transition phases.

    Before M72A: phase transitions changed the tools[] block →
                 Anthropic/OpenAI prompt-cache prefix invalidated →
                 every phase boundary paid a full re-ingestion cost.
    After M72A:  tools[] stable across the whole stage →
                 cache prefix persists through PLAN→EXPLORE→ACT→…→FINALIZE →
                 cost-per-turn drops materially on cache-aware providers.

    The synthetic `submit_phase_output` meta-tool is appended last, exactly
    as before — calling it advances the phase machine.
    """
    # Build the union of allowed tools across every phase row in the policy,
    # subtracting any that the phase explicitly forbids. Sorted for stable
    # ordering (cache hashes care about list order on some providers).
    union: dict[str, set[str]] = {}  # tool_name → set of phases it's allowed in
    for phase_policy in policy.phases.values():
        deny = phase_policy.forbidden_tools
        for tool_name in phase_policy.allowed_tools:
            if tool_name in deny:
                continue
            union.setdefault(tool_name, set()).add(phase_policy.phase.value)

    descriptors: list[dict[str, Any]] = []
    for tool_name in sorted(union.keys()):
        scopes = sorted(union[tool_name])
        descriptors.append({
            "name": tool_name,
            # Scope hint lives in the description so cache stays stable —
            # changing the description per phase would also invalidate the
            # cache. We embed ALL scopes here; the LLM reads them to know
            # when this tool is callable. Server-side enforcement is the
            # real gate. Keeping the descriptor strictly to `{name,
            # description, input_schema}` so Anthropic/OpenAI/Gemini schema
            # validators accept it unchanged.
            "description": (
                f"MCP tool '{tool_name}'. Phase scope: {', '.join(scopes)}. "
                f"Calling it outside its scope returns PHASE_TOOL_FORBIDDEN; "
                f"choose a tool whose scope includes the current phase."
            ),
            "input_schema": {"type": "object"},
        })
    # The meta-tool. The phase output schema lives in the prompt; we don't
    # try to mirror it as JSON Schema here (too many phase-specific shapes
    # to keep in sync). The validator catches any malformed payload.
    descriptors.append({
        "name": SUBMIT_PHASE_OUTPUT,
        "description": (
            "Submit the structured output for this phase and advance to the next phase. "
            "Call this when you have produced the receipt described in your prompt. "
            "Arguments: {payload: <phase-receipt object>, next_phase: <PHASE NAME>}."
        ),
        "input_schema": {
            "type": "object",
            "required": ["payload"],
            "properties": {
                "payload": {"type": "object", "description": "The phase receipt."},
                "next_phase": {
                    "type": "string",
                    "description": "Where to advance after validation. Omit to stay in current phase.",
                },
            },
        },
    })
    return descriptors


@dataclass(frozen=True)
class _MalformedSubmit:
    """Captures a submit_phase_output call we couldn't extract a valid
    receipt from. Surfaces to the caller (run_turn) so we can:

      1. Emit a `governed.submit_phase_output_malformed` audit event
         (previously silent — see code-review fix 2026-05-24).
      2. Feed a structured error back to the LLM via stage_driver's
         validation-error injection path so the next turn knows what
         went wrong.

    `reason` is the operator-readable explanation; `arg_keys` and
    `payload_type` give the structured detail the LLM needs to self-
    correct without us leaking arbitrary user data.
    """

    reason: str
    arg_keys: list[str]
    payload_type: str
    next_phase_raw: str | None


def _extract_phase_output(
    tool_calls: list[ChatToolCall],
) -> tuple[dict[str, Any] | None, Phase | None, list[ChatToolCall], _MalformedSubmit | None]:
    """Split a turn's tool calls into (phase_output, next_phase, other_calls, malformed).

    If the LLM called `submit_phase_output`:
      - Pull its `payload` (dict). When the provider stringified the payload
        (some models JSON-encode the inner value of tool args even when the
        outer arguments object is already an object), JSON-decode it.
      - Pull its `next_phase` (string → Phase enum, or None).
      - Remove it from the tool_calls list returned for dispatch.

    When the call exists but produces NO usable phase_output, return a
    `_MalformedSubmit` so the caller can:
      - emit an audit event (otherwise this looks like a no-op turn from
        outside the loop), and
      - feed a corrective error message back into the next turn (otherwise
        the LLM blindly repeats the same mistake until the stagnant-turn
        guard fires).

    Multiple `submit_phase_output` calls in one turn: the LAST valid one
    wins. If none is valid, the LAST attempt drives the malformed report
    so the LLM sees feedback on its most recent shape (the one it'd retry).
    """
    phase_output: dict[str, Any] | None = None
    next_phase: Phase | None = None
    other_calls: list[ChatToolCall] = []
    last_malformed: _MalformedSubmit | None = None
    for call in tool_calls:
        if call.name != SUBMIT_PHASE_OUTPUT:
            other_calls.append(call)
            continue
        args = call.arguments or {}
        payload_raw = args.get("payload")
        # Some providers return arguments where the inner `payload` is
        # still a JSON-encoded string even though llm_client.from_dict
        # already parsed the OUTER arguments object. One more decode
        # attempt before giving up. We also accept the case where the
        # whole arguments object IS the payload (`{story_brief: ..., ...}`
        # without a `payload` wrapper) since smaller models routinely
        # collapse the wrapper.
        payload: dict[str, Any] | None = None
        if isinstance(payload_raw, dict):
            payload = payload_raw
        elif isinstance(payload_raw, str):
            try:
                decoded = json.loads(payload_raw)
            except (json.JSONDecodeError, ValueError):
                decoded = None
            if isinstance(decoded, dict):
                payload = decoded
        elif payload_raw is None and isinstance(args, dict) and args:
            # The model put receipt fields at the top level of arguments
            # instead of nesting under `payload`. Pull them as the payload
            # but strip `next_phase` so it doesn't end up inside the
            # receipt itself.
            collapsed = {k: v for k, v in args.items() if k != "next_phase"}
            if collapsed:
                payload = collapsed

        np_str = args.get("next_phase")
        resolved_next: Phase | None = None
        if isinstance(np_str, str) and np_str:
            try:
                resolved_next = Phase(np_str)
            except ValueError:
                log.warning(
                    "submit_phase_output supplied unknown next_phase=%s; ignored", np_str
                )
                resolved_next = None

        if payload is not None:
            phase_output = payload
            next_phase = resolved_next
            last_malformed = None  # a later good call clears prior malformed
        else:
            reason_bits: list[str] = []
            if payload_raw is None:
                reason_bits.append("missing required field `payload`")
            elif isinstance(payload_raw, str):
                reason_bits.append(
                    "`payload` was a string; tried to JSON-decode it but the "
                    "result was not a JSON object"
                )
            else:
                reason_bits.append(
                    f"`payload` had type {type(payload_raw).__name__}; "
                    "expected a JSON object"
                )
            last_malformed = _MalformedSubmit(
                reason="; ".join(reason_bits),
                arg_keys=sorted(args.keys()) if isinstance(args, dict) else [],
                payload_type=type(payload_raw).__name__ if payload_raw is not None else "missing",
                next_phase_raw=np_str if isinstance(np_str, str) else None,
            )
    return phase_output, next_phase, other_calls, last_malformed


async def run_turn(
    *,
    state: PhaseState,
    stage_key: str,
    agent_role: str | None,
    vars: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    model_alias: str | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
) -> TurnResult:
    """Run one LLM turn end-to-end:

      1. Load StagePolicy.
      2. Resolve the per-phase prompt.
      3. Build messages + tool descriptors.
      4. Call llm-gateway.
      5. Parse tool calls, extract submit_phase_output.
      6. Run governance oracle.
      7. Return everything the caller needs to persist + render.

    Raises:
      PolicyNotFoundError   — no StagePolicy for this (stage_key, role).
      PromptNotFoundError   — no StagePromptBinding for this (stage_key, role, phase).
      LLMGatewayError       — endpoint-level LLM failure (timeout / 5xx / 429).
                              The caller decides whether to retry or surface.
    """
    history = history or []
    # Use a local copy so we don't mutate the caller's dict when we
    # inject the code-context-package below.
    vars = dict(vars or {})

    # 1. Policy.
    policy = await load_stage_policy(stage_key, agent_role, bearer=bearer)

    # Architecture gap #5 (2026-05-23) — code-context-package
    # integration. When the stage opts in via
    # context_policy.include_code_context_package, fetch the AST-
    # budgeted package from mcp-server and surface its markdown to
    # the per-phase prompt via vars["code_context_package"]. The
    # legacy /execute path has had this since M52; without this
    # injection the governed loop was strictly weaker for code-edit
    # stages.
    #
    # Opt-in (not default) so existing policies don't suddenly start
    # making an mcp-server round-trip on every turn. Fail-soft —
    # any error degrades to the existing prompt without breaking
    # the loop.
    ctx_policy = policy.context_policy if policy else {}
    if isinstance(ctx_policy, dict) and ctx_policy.get("include_code_context_package"):
        goal_text = ""
        if isinstance(vars.get("goal"), str):
            goal_text = vars["goal"]
        elif isinstance(vars.get("task"), str):
            goal_text = vars["task"]
        capability_id = None
        if isinstance(run_context, dict):
            capability_id = (
                run_context.get("capability_id")
                or run_context.get("capabilityId")
            )
        pkg, reason = await build_code_context_for_governed_turn(
            task_text=goal_text,
            capability_id=capability_id,
            run_context=run_context,
        )
        if pkg is not None:
            md = package_markdown(pkg)
            if md:
                vars["code_context_package"] = md
                vars["code_context_package_id"] = pkg.get("context_package_id", "")
                await emit_governed_event(
                    kind="governed.code_context_attached",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload={
                        "context_package_id": pkg.get("context_package_id"),
                        "markdown_bytes": len(md),
                    },
                )
        else:
            # Surfaces the reason in audit-gov so operators see the
            # degradation without it changing agent behavior.
            await emit_governed_event(
                kind="governed.code_context_skipped",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={"reason": reason or "unknown"},
                severity="warn",
            )

    # 2. Prompt — phase-specific if a binding exists, falls back via the
    # composer's ladder otherwise.
    prompt = await resolve_phase_prompt(
        stage_key=stage_key,
        agent_role=agent_role,
        phase=state.current_phase,
        vars=vars,
        bearer=bearer,
    )

    # 3. Messages + tool descriptors.
    messages = _build_messages(prompt, history)
    tools = _build_tool_descriptors(policy, state.current_phase)

    # Audit the LLM call now — useful for cost accounting even when the
    # call fails. The completion event lands after the response below.
    await emit_governed_event(
        kind="governed.llm_request",
        state=state,
        policy=policy,
        run_context=run_context,
        payload={
            "binding_id": prompt.binding_id,
            "prompt_profile_id": prompt.prompt_profile_id,
            "tool_count": len(tools),
            "history_messages": len(history),
        },
    )

    # 4. LLM call.
    response: ChatResponse = await call_gateway_chat(
        messages=messages,
        tools=tools,
        model_alias=model_alias,
        bearer=bearer,
    )

    await emit_governed_event(
        kind="governed.llm_response",
        state=state,
        policy=policy,
        run_context=run_context,
        payload={
            "finish_reason": response.finish_reason,
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
            "tool_call_count": len(response.tool_calls),
            "provider": response.provider,
            "model": response.model,
            "estimated_cost": response.estimated_cost,
        },
    )

    # 5. Split tool calls.
    phase_output, next_phase, other_calls, malformed = _extract_phase_output(
        response.tool_calls
    )

    # 5a. (Code-review fix 2026-05-24) — surface malformed submit_phase_output
    # calls instead of silently dropping them. Without this:
    #   - no audit event fires (operators can't tell why a stage stalled),
    #   - the LLM gets no validation feedback (the stage_driver's
    #     validation-error injection only runs when step.validation_error
    #     is set), and
    #   - the stagnant-turn guard eventually fires POLICY_BLOCKED, which
    #     looks like a refusal but is actually a shape bug.
    # We emit the event AND set a validation_error on the synthesized step
    # result so stage_driver's existing retry/feedback path takes over.
    if malformed is not None and phase_output is None and not other_calls:
        log.info(
            "submit_phase_output malformed phase=%s reason=%s",
            state.current_phase.value,
            malformed.reason,
        )
        await emit_governed_event(
            kind="governed.submit_phase_output_malformed",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                "phase": state.current_phase.value,
                "reason": malformed.reason,
                "arg_keys": malformed.arg_keys,
                "payload_type": malformed.payload_type,
                "next_phase_raw": malformed.next_phase_raw,
            },
            severity="warn",
        )
        # Build a synthetic GovernedStepResult so the driver's existing
        # validation_error retry path injects a corrective message into
        # the next turn. We bypass governed_step entirely (nothing to
        # dispatch and no receipt to validate) but keep the shape it
        # would have produced.
        synthetic_step = GovernedStepResult(
            next_state=state,
            from_phase=state.current_phase.value,
            to_phase=state.current_phase.value,
            validation_error={
                "error_code": "SUBMIT_PHASE_OUTPUT_MALFORMED",
                "phase": state.current_phase.value,
                "reason": (
                    "Your last submit_phase_output call could not be parsed: "
                    f"{malformed.reason}. The synthetic tool expects "
                    "arguments shaped exactly as "
                    "{ payload: <object>, next_phase: <PHASE NAME or omit> }. "
                    "`payload` must be a JSON object, not a string. Put the "
                    "receipt fields described in your prompt INSIDE `payload`."
                ),
                "details": [
                    {"field": "payload", "issue": malformed.reason},
                ],
                "arg_keys_seen": malformed.arg_keys,
                "payload_type_seen": malformed.payload_type,
            },
        )
        return TurnResult(
            next_state=state,
            step=synthetic_step,
            llm={
                "content": response.content,
                "finish_reason": response.finish_reason,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "latency_ms": response.latency_ms,
                "provider": response.provider,
                "model": response.model,
                "model_alias": response.model_alias,
                "estimated_cost": response.estimated_cost,
                "tool_call_count": len(response.tool_calls),
            },
            prompt={
                "binding_id": prompt.binding_id,
                "prompt_profile_id": prompt.prompt_profile_id,
                "phase_used": prompt.phase,
                "stage_key": prompt.stage_key,
                "agent_role": prompt.agent_role,
            },
            policy={
                "policy_id": policy.policy_id,
                "stage_key": policy.stage_key,
                "agent_role": policy.agent_role,
                "version": policy.version,
                "max_repair_attempts": policy.max_repair_attempts,
            },
        )

    # 5b. No tool call at all is also a stagnant-turn risk — the LLM
    # produced prose but didn't advance. Emit a marker event so the
    # silent stagnant→POLICY_BLOCKED path is observable. We don't synthesize
    # a validation_error here because the prompt itself may have asked for
    # a thought-only turn (rare but allowed); the stagnant guard will still
    # halt the stage after _STAGNANT_THRESHOLD repetitions.
    if (
        phase_output is None
        and not other_calls
        and malformed is None
        and len(response.tool_calls) == 0
    ):
        await emit_governed_event(
            kind="governed.no_tool_called",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                "phase": state.current_phase.value,
                "content_chars": len(response.content or ""),
                "finish_reason": response.finish_reason,
            },
            severity="warn",
        )

    # 6. Hand to the governance oracle. Tool calls go through hard-refuse;
    # phase_output goes through the validator + state machine.
    dispatch_payloads = [
        {"tool_name": tc.name, "args": tc.arguments, "id": tc.id}
        for tc in other_calls
    ]
    step = await governed_step(
        state=state,
        stage_key=stage_key,
        agent_role=agent_role,
        tool_calls=dispatch_payloads,
        phase_output=phase_output,
        next_phase=next_phase,
        run_context=run_context,
        bearer=bearer,
        policy=policy,
    )

    return TurnResult(
        next_state=step.next_state,
        step=step,
        llm={
            "content": response.content,
            "finish_reason": response.finish_reason,
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
            "latency_ms": response.latency_ms,
            "provider": response.provider,
            "model": response.model,
            "model_alias": response.model_alias,
            "estimated_cost": response.estimated_cost,
            "tool_call_count": len(response.tool_calls),
        },
        prompt={
            "binding_id": prompt.binding_id,
            "prompt_profile_id": prompt.prompt_profile_id,
            "phase_used": prompt.phase,
            "stage_key": prompt.stage_key,
            "agent_role": prompt.agent_role,
        },
        policy={
            "policy_id": policy.policy_id,
            "stage_key": policy.stage_key,
            "agent_role": policy.agent_role,
            "version": policy.version,
            "max_repair_attempts": policy.max_repair_attempts,
        },
    )
