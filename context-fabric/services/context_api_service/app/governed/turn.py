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

import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from .audit_emit import emit_governed_event
from .llm_client import ChatResponse, ChatToolCall, LLMGatewayError, call_gateway_chat
from .loop import GovernedStepResult, governed_step
from .phase_state import Phase, PhaseState
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
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

    History items are appended verbatim so the caller can implement multi-
    turn loops without us inventing a history format.
    """
    messages: list[dict[str, Any]] = []
    if prompt.system_prompt_append.strip():
        messages.append({"role": "system", "content": prompt.system_prompt_append})
    body = prompt.task
    if prompt.extra_context.strip():
        body = f"{body}\n\n{prompt.extra_context}"
    if body:
        messages.append({"role": "user", "content": body})
    messages.extend(history)
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


def _extract_phase_output(
    tool_calls: list[ChatToolCall],
) -> tuple[dict[str, Any] | None, Phase | None, list[ChatToolCall]]:
    """Split a turn's tool calls into (phase_output, next_phase, other_calls).

    If the LLM called `submit_phase_output`:
      - Pull its `payload` (dict).
      - Pull its `next_phase` (string → Phase enum, or None).
      - Remove it from the tool_calls list returned for dispatch.

    Multiple `submit_phase_output` calls in one turn: the LAST one wins (the
    LLM has the receipt-shape rules in the prompt; if it submits twice the
    second is its corrected attempt).
    """
    phase_output: dict[str, Any] | None = None
    next_phase: Phase | None = None
    other_calls: list[ChatToolCall] = []
    for call in tool_calls:
        if call.name != SUBMIT_PHASE_OUTPUT:
            other_calls.append(call)
            continue
        args = call.arguments or {}
        payload = args.get("payload")
        if isinstance(payload, dict):
            phase_output = payload
        np_str = args.get("next_phase")
        if isinstance(np_str, str) and np_str:
            try:
                next_phase = Phase(np_str)
            except ValueError:
                log.warning(
                    "submit_phase_output supplied unknown next_phase=%s; ignored", np_str
                )
                next_phase = None
    return phase_output, next_phase, other_calls


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

    # 1. Policy.
    policy = await load_stage_policy(stage_key, agent_role, bearer=bearer)

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
    phase_output, next_phase, other_calls = _extract_phase_output(response.tool_calls)

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
