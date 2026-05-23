"""
M71 Slice F — Multi-turn stage driver.

`run_turn` (Slice C(b)) handles ONE LLM round trip. workgraph-api today
expects to call /execute and get back a fully-completed stage — not a
single turn. To keep workgraph-api dumb, this module wraps `run_turn`
in a loop that keeps calling until:

  * the phase machine reaches a terminal state (FINALIZE), OR
  * SELF_REVIEW recommends approval (approval_pending=True → caller opens
    the approval gate; LLM doesn't auto-advance into FINALIZE), OR
  * a validation error blocks the turn (caller decides whether to retry), OR
  * max_turns reached (safety cap to avoid runaway costs).

The driver also threads OpenAI-style history forward so each subsequent
turn sees the LLM's prior tool calls + their results. Without this the
LLM would re-do the same exploration every turn.
"""
from __future__ import annotations

import json
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .audit_emit import emit_governed_event
from .llm_client import LLMGatewayError
from .loop import GovernedStepResult, ToolCallOutcome
from .phase_state import Phase, PhaseState
from .policy_loader import PolicyNotFoundError
from .prompt_resolver import PromptNotFoundError
from .turn import SUBMIT_PHASE_OUTPUT, TurnResult, run_turn

log = logging.getLogger(__name__)


# Hard safety cap. The StagePolicy.limits.max_tool_calls would also apply
# but is checked per-call inside run_turn. This one is the worst-case
# escape hatch in case of a runaway repair loop.
DEFAULT_MAX_TURNS = 25


@dataclass
class StageRunResult:
    """Full outcome of `run_stage`. Caller persists `final_state` + records
    `turns` for audit/replay."""

    final_state: PhaseState
    turns: list[dict[str, Any]] = field(default_factory=list)
    # Why we stopped looping. One of: "FINALIZED", "APPROVAL_PENDING",
    # "VALIDATION_BLOCKED", "POLICY_BLOCKED", "MAX_TURNS", "LLM_ERROR".
    stop_reason: str = ""
    # When stop_reason == "LLM_ERROR", carries the gateway's error_code.
    error_code: str | None = None
    error_message: str | None = None
    # Aggregated counters — workgraph-api stamps these on the audit row.
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_tool_calls: int = 0
    total_tools_refused: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "final_state": self.final_state.to_dict(),
            "turns": self.turns,
            "stop_reason": self.stop_reason,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "totals": {
                "input_tokens": self.total_input_tokens,
                "output_tokens": self.total_output_tokens,
                "tool_calls": self.total_tool_calls,
                "tools_refused": self.total_tools_refused,
            },
        }


def _history_from_turn(turn: TurnResult) -> list[dict[str, Any]]:
    """Build the message-history pair that represents `turn`:

      - one assistant message with the LLM's content + tool_calls
      - one tool message per tool call carrying the dispatched result
        (or the refusal reason)

    The shape mirrors OpenAI's chat-completion message format. Provider
    differences are normalised inside llm-gateway, so this format works
    for Anthropic/OpenAI/mock without further adaptation.
    """
    # Assistant message — include the tool_calls block so the next turn's
    # LLM sees what it called last time. id values are stable per call so
    # the matched tool result message wires up correctly.
    tool_calls_block: list[dict[str, Any]] = []
    for outcome in turn.step.tool_outcomes:
        # M73-followup #4 — JSON-serialize the original args the LLM emitted.
        # Previously this was the empty string with a comment claiming "LLM
        # has them in its memory" — true within a single live LLM session,
        # but false the moment the stage pauses for human approval and
        # resumes hours later from persisted history (the resumed LLM is
        # restarted from message history alone). Cost is one JSON dump per
        # call; correctness is unbounded.
        try:
            args_str = json.dumps(outcome.args, separators=(",", ":"), default=str)
        except (TypeError, ValueError):
            # Defensive: a tool arg that isn't JSON-serializable should
            # never reach here (the LLM-side normalisation rejects them)
            # but if it does, fall back to repr so we don't crash the
            # whole turn over a logging detail.
            args_str = json.dumps({"__unserializable__": repr(outcome.args)})
        tool_calls_block.append({
            "id": outcome.tool_invocation_id or f"refused:{outcome.tool_name}",
            "type": "function",
            "function": {
                "name": outcome.tool_name,
                "arguments": args_str,
            },
        })

    messages: list[dict[str, Any]] = []
    if turn.llm.get("content") or tool_calls_block:
        messages.append({
            "role": "assistant",
            "content": turn.llm.get("content", ""),
            "tool_calls": tool_calls_block,
        })

    # One tool message per outcome.
    for outcome in turn.step.tool_outcomes:
        tool_call_id = outcome.tool_invocation_id or f"refused:{outcome.tool_name}"
        if outcome.allowed:
            # Allowed → dispatched. Serialise the result + tool-level error
            # so the LLM can react to verification failures, etc.
            body = {
                "tool_success": outcome.tool_success,
                "result": outcome.result,
            }
            if outcome.tool_error:
                body["tool_error"] = outcome.tool_error
            if outcome.dispatch_error:
                body["dispatch_error"] = outcome.dispatch_error
        else:
            # Refused → tell the LLM exactly what to try instead.
            body = {
                "error": "PHASE_TOOL_FORBIDDEN",
                "reason": outcome.refusal_reason,
                "allowed_tools": outcome.allowed_tools,
            }
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": json.dumps(body),
        })

    return messages


def _render_auto_verify_message(synth: dict[str, Any]) -> dict[str, Any]:
    """M74 Phase 1A — render a SyntheticVerifierResult (already
    serialized to dict in loop.py) as a user-role message for the next
    turn's prompt. Mirrors SyntheticVerifierResult.to_history_message in
    verify_synthesis.py but works on the dict form so stage_driver
    doesn't import the dataclass."""
    kind = synth.get("kind")
    if kind == "ran":
        verdict = "PASSED" if synth.get("tool_success") else "FAILED"
        parts = [
            f"[AUTO-VERIFY] Automated verification ran on your edits: {verdict}.",
            f"Command: {synth.get('command')}",
        ]
        if synth.get("exit_code") is not None:
            parts.append(f"Exit code: {synth.get('exit_code')}")
        stdout = synth.get("stdout_summary") or ""
        if stdout:
            parts.append(f"stdout: {stdout[:1500]}")
        stderr = synth.get("stderr_summary") or ""
        if stderr:
            parts.append(f"stderr: {stderr[:1500]}")
        parts.append(
            "Include this command in your VerificationReceipt.commands_run "
            "(don't re-run it; the result is above). If it FAILED, the next "
            "phase should be REPAIR, not SELF_REVIEW."
        )
        return {"role": "user", "content": "\n".join(parts)}
    if kind == "skipped":
        reason = synth.get("reason") or "no runnable verifier"
        return {
            "role": "user",
            "content": (
                f"[AUTO-VERIFY] No runnable verifier was available ({reason}). "
                "Call verification_unavailable with the same reason, or "
                "run_test if you know an applicable command."
            ),
        }
    # unavailable or unknown kind
    reason = synth.get("reason") or "synthesis failed"
    return {
        "role": "user",
        "content": (
            f"[AUTO-VERIFY] Verification synthesis failed: {reason}. "
            "You may need to call run_test yourself; the orchestrator "
            "could not pick a command."
        ),
    }


def _is_terminal_state(state: PhaseState) -> bool:
    """The stage is done when the machine reaches FINALIZE — there's no
    way out of FINALIZE in the transition table."""
    return state.current_phase is Phase.FINALIZE


# ── M74 Phase 1D — stagnant-phase helpers ──────────────────────────────────
#
# These are pulled out as pure functions so the detector logic is testable
# without spinning up the whole async run_stage loop. The signatures are
# (turn, recent_windows) → (set | bool); both are deterministic and
# side-effect free.


def _turn_tool_signatures(turn: TurnResult) -> set[str]:
    """Compute the set of (tool_name, canonical_args) signatures for the
    DISPATCHED tool calls in this turn. Refused calls are deliberately
    excluded — a refused call is the exact signal that would otherwise
    trip the stagnant guard, and counting it as "progress" would defeat
    the purpose of the detector."""
    sigs: set[str] = set()
    for outcome in turn.step.tool_outcomes:
        if not outcome.allowed:
            continue
        try:
            args_canon = json.dumps(
                outcome.args, sort_keys=True, separators=(",", ":"), default=str,
            )
        except (TypeError, ValueError):
            # Unserialisable args shouldn't reach here (normalised at
            # outcome construction) but fall back to repr defensively.
            args_canon = repr(outcome.args)
        sigs.add(f"{outcome.tool_name}:{args_canon}")
    return sigs


def _turn_made_progress(
    turn_sigs: set[str],
    recent_windows: "deque[set[str]]",
) -> bool:
    """A turn made progress if it introduced at least one tool-call
    signature that's not in the recent window of prior turns. Empty
    turns (no dispatched calls) are NOT progress — they didn't do
    anything.

    The window size is bounded by recent_windows.maxlen (set by the
    caller). With maxlen=4, calling read_file(a) → read_file(b) →
    read_file(c) → read_file(d) → read_file(e) all count as progress;
    calling read_file(a) again on turn 6 also counts (a fell out of
    the window). That's intentional — re-reading after long enough
    might be legitimate (file changed) and we'd rather underrefuse
    than overrefuse exploration.
    """
    if not turn_sigs:
        return False
    prior = set().union(*recent_windows) if recent_windows else set()
    return bool(turn_sigs - prior)


def _accumulate_totals(result: StageRunResult, turn: TurnResult) -> None:
    result.total_input_tokens += int(turn.llm.get("input_tokens") or 0)
    result.total_output_tokens += int(turn.llm.get("output_tokens") or 0)
    for outcome in turn.step.tool_outcomes:
        result.total_tool_calls += 1
        if not outcome.allowed:
            result.total_tools_refused += 1


async def run_stage(
    *,
    state: PhaseState,
    stage_key: str,
    agent_role: str | None,
    vars: dict[str, Any] | None = None,
    initial_history: list[dict[str, Any]] | None = None,
    model_alias: str | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> StageRunResult:
    """Drive an entire stage by repeatedly calling `run_turn`.

    Returns when one of these halt conditions hits:

      * `next_state.current_phase == FINALIZE`  → "FINALIZED"
      * `next_state.approval_pending == True`   → "APPROVAL_PENDING"
                                                  (SELF_REVIEW recommended approval)
      * `step.validation_error is not None`     → "VALIDATION_BLOCKED"
                                                  (caller decides retry vs surface)
      * `turn.step.next_state == state` for two
         consecutive turns                       → "POLICY_BLOCKED"
                                                  (LLM is stuck calling refused tools)
      * `turns_taken >= max_turns`               → "MAX_TURNS"
      * `LLMGatewayError`                        → "LLM_ERROR"

    The caller (workgraph-api) wraps the result into an attempt record and
    decides what to render. Future-proof: when SELF_REVIEW says
    `approval_pending=true` the stage halts BEFORE FINALIZE so the human
    gate can run between the two phases.
    """
    history = list(initial_history or [])
    result = StageRunResult(final_state=state)

    # M74 Phase 1D — stagnant-phase detector.
    #
    # Old behaviour: 2 consecutive turns with the same phase and no advance
    # tripped POLICY_BLOCKED. That conflates two failure modes:
    #
    #   * Real loop: the model keeps calling the same refused tool. Two
    #     turns is plenty to detect.
    #   * Slow progress: the model is reading files one at a time, taking
    #     3-4 turns to gather enough context before submitting a phase
    #     output. Counts as stagnant under the old rule even though work
    #     is happening.
    #
    # New rule:
    #   1. Threshold raised from 2 to 3 consecutive non-progressing turns.
    #   2. A turn counts as progress when it dispatched at least one tool
    #      whose (name, args) signature was NOT seen in the last
    #      _STAGNANT_WINDOW_TURNS turns. Calling read_file on different
    #      files counts as progress; calling apply_patch with identical
    #      args twice doesn't.
    #   3. Phase change / phase advance still reset the counter (unchanged).
    _STAGNANT_THRESHOLD = 3
    _STAGNANT_WINDOW_TURNS = 4
    stagnant_turns = 0
    prior_phase = state.current_phase
    # Sliding window of per-turn tool signature sets. Used to decide
    # whether the current turn introduced anything novel.
    recent_signatures: deque[set[str]] = deque(maxlen=_STAGNANT_WINDOW_TURNS)

    for turn_idx in range(max_turns):
        try:
            turn = await run_turn(
                state=state,
                stage_key=stage_key,
                agent_role=agent_role,
                vars=vars,
                history=history,
                model_alias=model_alias,
                run_context=run_context,
                bearer=bearer,
            )
        except LLMGatewayError as exc:
            result.stop_reason = "LLM_ERROR"
            result.error_code = exc.error_code
            result.error_message = str(exc)
            await emit_governed_event(
                kind="governed.stage_aborted",
                state=state,
                policy=None,
                run_context=run_context,
                payload={"reason": exc.error_code, "turn_idx": turn_idx},
                severity="warn",
            )
            return result

        # Persist + accumulate.
        turn_dict = {
            "turn_index": turn_idx,
            "from_phase": turn.step.from_phase,
            "to_phase": turn.step.to_phase,
            "phase_advanced": turn.step.phase_advanced,
            "tool_outcomes": [_outcome_dict(o) for o in turn.step.tool_outcomes],
            "validation_error": turn.step.validation_error,
            "llm": turn.llm,
            "prompt": turn.prompt,
        }
        result.turns.append(turn_dict)
        _accumulate_totals(result, turn)

        # Append this turn's assistant + tool messages to the history that
        # the next turn will see.
        history.extend(_history_from_turn(turn))

        # M74 Phase 1A — when ACT advanced and the orchestrator auto-verified
        # on the agent's behalf, inject a system-style user message with the
        # verifier output so the LLM enters VERIFY with real evidence.
        # Deliberately a user message (not a synthetic tool_call/tool_result
        # pair) because the LLM didn't emit the call — faking provenance
        # would lie to downstream auditing and break the args-roundtrip
        # contract from M73-followup #4.
        synth = turn.step.synthetic_verifier
        if synth:
            history.append(_render_auto_verify_message(synth))

        state = turn.next_state
        result.final_state = state

        # Halt conditions, in priority order.
        if state.approval_pending and state.current_phase is Phase.SELF_REVIEW:
            result.stop_reason = "APPROVAL_PENDING"
            return result

        if _is_terminal_state(state):
            result.stop_reason = "FINALIZED"
            return result

        if turn.step.validation_error and not turn.step.phase_advanced:
            # The LLM submitted a malformed receipt. Letting the loop run
            # will burn turns on the same broken output. Surface to caller.
            result.stop_reason = "VALIDATION_BLOCKED"
            return result

        # M74 Phase 1D — stagnant-phase guard with novelty exception.
        # See the comment near _STAGNANT_THRESHOLD above for the design.
        turn_signatures = _turn_tool_signatures(turn)
        made_progress = _turn_made_progress(turn_signatures, recent_signatures)
        recent_signatures.append(turn_signatures)

        phase_changed = state.current_phase is not prior_phase
        if phase_changed or turn.step.phase_advanced or made_progress:
            stagnant_turns = 0
            prior_phase = state.current_phase
        else:
            stagnant_turns += 1
            if stagnant_turns >= _STAGNANT_THRESHOLD:
                result.stop_reason = "POLICY_BLOCKED"
                return result

    result.stop_reason = "MAX_TURNS"
    return result


def _outcome_dict(outcome: ToolCallOutcome) -> dict[str, Any]:
    """ToolCallOutcome → JSON-serialisable dict for the turns array."""
    return {
        "tool_name": outcome.tool_name,
        "phase": outcome.phase,
        "allowed": outcome.allowed,
        "refusal_reason": outcome.refusal_reason,
        "allowed_tools": outcome.allowed_tools,
        # M71 Slice F — surface the dispatched tool result so workgraph-api's
        # adapter can harvest code_change_id + verification_result envelopes
        # from the same outcome stream the LLM saw.
        "result": outcome.result,
        "duration_ms": outcome.duration_ms,
        "tool_invocation_id": outcome.tool_invocation_id,
        "tool_success": outcome.tool_success,
        "tool_error": outcome.tool_error,
        "dispatch_error": outcome.dispatch_error,
    }
