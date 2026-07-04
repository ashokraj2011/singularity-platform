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

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .audit_emit import emit_governed_event
from .history_compression import DEFAULT_RECENT_TURNS, compress_history
from .llm_client import LLMGatewayError
from .loop import GovernedStepResult, ToolCallOutcome
from .memory_capture import capture_run_outcome_memory
from .phase_state import Phase, PhaseState, advance_phase
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
from .stage_execution_policy import StageExecutionPolicy, StageExecutionPolicyError, apply_execution_policy
from .prompt_resolver import PromptNotFoundError
from .turn import MinContextUnavailable, SUBMIT_PHASE_OUTPUT, TurnResult, run_turn
from .verify_synthesis import SyntheticVerifierResult, synthesize_verifier_run
from .env_config import bounded_float_env, bounded_int_env
# M99 S1.1 — deterministic pre-ACT localization (platform-driven, gated OFF
# by default via governed_automation; see localization.py).
# M99 S1.3 — git push preflight (platform-driven, same gating; see git_preflight.py).
# M99 S2.1 — platform-driven auto-baseline (same gating; see auto_baseline.py).
from .governed_automation import automation_enabled
from .localization import synthesize_localization
from .git_preflight import synthesize_git_preflight
from .auto_baseline import synthesize_baseline
from .baseline_diff import BASELINE_STASH_KEY
from .receipts import BaselineReceipt, GitPreflightReceipt, LocalizationReceipt

log = logging.getLogger(__name__)


# Hard safety cap. The StagePolicy.limits.max_tool_calls would also apply
# but is checked per-call inside run_turn. This one is the worst-case
# escape hatch in case of a runaway repair loop.
DEFAULT_MAX_TURNS = 25
# Wall-clock safety deadline for a whole governed stage. max_turns bounds the
# turn COUNT, but a stage of slow turns can still run far past any HTTP client's
# patience. The workgraph→CF client aborts a governed stage at 900s
# (client.ts executeGovernedStage default envelope); we self-terminate at 780s
# — comfortably BELOW that — so CF returns a clean terminal result (stop_reason
# STAGE_DEADLINE, which workgraph maps to FAILED/restartable) instead of being
# orphaned by the client abort and then duplicated by the retry. 0 disables.
# Keep this < the client envelope if you tune either side.
STAGE_WALL_CLOCK_SEC = bounded_float_env(
    "GOVERNED_STAGE_WALL_CLOCK_SEC",
    default=780.0,
    min_value=0.0,
    max_value=24.0 * 60.0 * 60.0,
    logger=log,
)
LLM_RETRY_ATTEMPTS = bounded_int_env(
    "GOVERNED_LLM_RETRY_ATTEMPTS",
    default=2,
    min_value=0,
    max_value=10,
    logger=log,
)
LLM_RETRY_BASE_DELAY_SEC = bounded_float_env(
    "GOVERNED_LLM_RETRY_BASE_DELAY_SEC",
    default=1.0,
    min_value=0.1,
    max_value=60.0,
    logger=log,
)
_TRANSIENT_LLM_ERROR_CODES = {
    "LLM_GATEWAY_TIMEOUT",
    "LLM_GATEWAY_UNAVAILABLE",
    "LLM_GATEWAY_UPSTREAM_ERROR",
    "LLM_PROVIDER_OVERLOADED",
}


@dataclass
class StageRunResult:
    """Full outcome of `run_stage`. Caller persists `final_state` + records
    `turns` for audit/replay."""

    final_state: PhaseState
    turns: list[dict[str, Any]] = field(default_factory=list)
    # Why we stopped looping. One of: "FINALIZED", "APPROVAL_PENDING",
    # "NOT_ACTIONABLE", "VALIDATION_BLOCKED", "POLICY_BLOCKED",
    # "PHASE_BUDGET_EXCEEDED", "MAX_TURNS", "LLM_ERROR", "NEEDS_CONTEXT" (the
    # min-context gate paused a code-edit stage), "GOVERNANCE_BLOCKED" (a
    # BLOCKING/REQUIRED governance control was unmet at promotion), and the M96 salvage
    # outcomes "SALVAGED_VERIFY_FAILED" / "SALVAGED_VERIFY_UNAVAILABLE" (the
    # orchestrator recovered real edits a stuck mutating phase produced and
    # ran the verifier; a passing verifier instead yields "APPROVAL_PENDING").
    # Only FINALIZED / APPROVAL_PENDING / NOT_ACTIONABLE map to COMPLETED in
    # workgraph-api; the SALVAGED_* reasons remain FAILED but preserve the
    # edits + verifier evidence for the next attempt / human review.
    stop_reason: str = ""
    # When stop_reason == "LLM_ERROR", carries the gateway's error_code.
    error_code: str | None = None
    error_message: str | None = None
    # M95 — when stop_reason == "NOT_ACTIONABLE", carries {actionable,
    # reason, evidence} from the PLAN receipt so workgraph-api / the
    # approval gate can render "Story not actionable — pending human
    # confirmation" with the agent's justification.
    not_actionable: dict[str, Any] | None = None
    # When stop_reason == "NEEDS_CONTEXT", carries {reason, phase, context_policy}
    # from the min-context gate so the approval/inbox UI can render
    # "Paused — insufficient code context" with the specifics.
    needs_context: dict[str, Any] | None = None
    # Capability Governance Model — when stop_reason == "GOVERNANCE_BLOCKED",
    # carries {controls, allowedActions, overlayHash}: the unsatisfied
    # REQUIRED/BLOCKING governance controls that blocked promotion, plus the
    # actions that can unblock (submit evidence / run verifier / request waiver).
    governance_block: dict[str, Any] | None = None
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
            "not_actionable": self.not_actionable,
            "needs_context": self.needs_context,
            "governance_block": self.governance_block,
            "totals": {
                "input_tokens": self.total_input_tokens,
                "output_tokens": self.total_output_tokens,
                "tool_calls": self.total_tool_calls,
                "tools_refused": self.total_tools_refused,
            },
        }


_REFUSAL_ID_COUNTER = {"n": 0}


def _refusal_synthetic_id(tool_name: str) -> str:
    """Generate an Anthropic-safe synthetic tool_use id for refused calls.

    Anthropic's Messages API enforces tool_use.id to match
    `^[a-zA-Z0-9_-]{1,256}$`. The previous fallback `f"refused:{tool}"`
    embedded a colon which violates the pattern and 400'd the next
    turn with "messages.N.content.0.tool_use.id: String should match
    pattern '...'", killing the whole stage right after a refusal.

    We swap to underscores and append a monotonically-increasing counter
    so multiple refusals in the same turn don't collide (Anthropic also
    refuses duplicate ids within a single content array).
    """
    _REFUSAL_ID_COUNTER["n"] += 1
    safe_tool = "".join(c if (c.isalnum() or c in "_-") else "_" for c in tool_name)
    return f"refused_{safe_tool}_{_REFUSAL_ID_COUNTER['n']}"


def _history_from_turn(turn: TurnResult) -> list[dict[str, Any]]:
    """Build the message-history pair that represents `turn`:

      - one assistant message with the LLM's content + tool_calls
      - one tool message per tool call carrying the dispatched result
        (or the refusal reason)

    The shape mirrors OpenAI's chat-completion message format. Provider
    differences are normalised inside llm-gateway, so this format works
    for Anthropic/OpenAI/mock without further adaptation.
    """
    # (2026-05-24 RCA) Compute the synthetic id for each outcome ONCE
    # so the assistant tool_use block and the matching tool_result
    # block carry identical ids. Earlier this called
    # _refusal_synthetic_id() twice per refused outcome — once in the
    # tool_calls_block loop, once in the tool-message loop — and the
    # counter incremented between them, producing assistant ids
    # `refused_get_symbol_5,6` paired with tool_result ids
    # `refused_get_symbol_7,8` that don't match. Anthropic 400'd with
    # "unexpected tool_use_id" and the stage died right after a
    # refusal.
    resolved_ids: list[str] = []
    for outcome in turn.step.tool_outcomes:
        resolved_ids.append(
            outcome.tool_invocation_id or _refusal_synthetic_id(outcome.tool_name)
        )

    # Assistant message — include the tool_calls block so the next turn's
    # LLM sees what it called last time. id values are stable per call so
    # the matched tool result message wires up correctly.
    tool_calls_block: list[dict[str, Any]] = []
    for outcome, call_id in zip(turn.step.tool_outcomes, resolved_ids):
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
            "id": call_id,
            "type": "function",
            "function": {
                "name": outcome.tool_name,
                "arguments": args_str,
            },
        })

    messages: list[dict[str, Any]] = []
    # (2026-05-24 RCA) — strip the assistant content before threading
    # it into history. Anthropic's Messages API 400s on assistant content
    # that ends with trailing whitespace ("messages: final assistant
    # content cannot end with trailing whitespace"). Haiku occasionally
    # emits content=" " (a single space) alongside a tool_call block; if
    # we preserve that verbatim, the NEXT turn's request to Anthropic
    # fails with a 400 and stops the entire stage. Stripping is safe —
    # leading/trailing whitespace carries no semantic load, and an
    # empty content string is fine for an assistant message that's
    # only there to anchor a tool_call.
    raw_content = turn.llm.get("content", "")
    if isinstance(raw_content, str):
        normalized_content = raw_content.strip()
    else:
        normalized_content = raw_content
    if normalized_content or tool_calls_block:
        # M83.r — thread thinking blocks back into history when the
        # turn produced any. Required for Anthropic tool-use
        # continuation: if a turn with thinking+tool_use isn't
        # echoed back with the same thinking blocks (signatures
        # intact) in the next assistant message, the next tool_result
        # message 400s. The gateway's Anthropic converter consumes
        # ChatMessage.thinking_blocks and emits them as `thinking`
        # content blocks BEFORE the tool_use blocks (correct order
        # per Anthropic docs). Non-Anthropic providers ignore.
        thinking_blocks_raw = turn.llm.get("thinking_blocks") or []
        thinking_blocks = (
            [tb for tb in thinking_blocks_raw if isinstance(tb, dict)]
            if isinstance(thinking_blocks_raw, list) else []
        )
        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "content": normalized_content,
            "tool_calls": tool_calls_block,
        }
        if thinking_blocks:
            assistant_msg["thinking_blocks"] = thinking_blocks
        messages.append(assistant_msg)

    # One tool message per outcome. Reuse the id we computed for the
    # assistant tool_use block above so they always match.
    for outcome, tool_call_id in zip(turn.step.tool_outcomes, resolved_ids):
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


# M99 S2.2 — sentinel for the AutoVerificationReceipt in state.receipts.
_AUTO_VERIFICATION_KEY = "__auto_verification__"


def _auto_verification_receipt_from_synth(synth: dict[str, Any]) -> dict[str, Any]:
    """M99 S2.2 — map the auto-verify synth dict (SyntheticVerifierResult.
    to_dict() shape from loop.py) onto an AutoVerificationReceipt dict.

    kind="ran"+tool_success → passed; kind="ran"+!tool_success → failed;
    kind in {skipped, unavailable} → unavailable. The failing-test set is
    not parsed here (the synth only carries stdout/stderr summaries); the
    authoritative regression diff lives on the VerificationReceipt via
    baseline_diff.enrich_verification_receipt. This receipt is the audit
    record that the platform DID run a verifier and what it observed.
    """
    from .receipts import AutoVerificationReceipt  # local import: avoids a cycle at module load

    kind = synth.get("kind")
    if kind == "ran":
        status = "passed" if synth.get("tool_success") else "failed"
        tests_ran = True
    else:
        status = "unavailable"
        tests_ran = False
    command = synth.get("command")
    commands_run = [str(command)] if command else []
    summary_bits = []
    if synth.get("reason"):
        summary_bits.append(str(synth["reason"]))
    if synth.get("exit_code") is not None:
        summary_bits.append(f"exit={synth['exit_code']}")
    return AutoVerificationReceipt(
        status=status,
        tests_ran=tests_ran,
        commands_run=commands_run,
        summary="; ".join(summary_bits) or None,
        origin="auto",
    ).model_dump(mode="json")


def _render_validation_error_message(validation_error: Any) -> dict[str, Any]:
    """Review fix #3 (2026-05-23) — render a phase_output validation
    error as a user-role message so the LLM can see exactly what
    was wrong with its receipt and fix it on the next turn.

    `validation_error` is the dict returned by PhaseOutputInvalid.
    to_dict() (see loop.py / validators.py); fields include `phase`,
    `reason`, and `details` (a list of per-field problems).
    """
    if not isinstance(validation_error, dict):
        # Defensive: if the shape isn't what we expect, still emit a
        # message — losing the structured detail is better than the
        # LLM seeing nothing and guessing.
        return {
            "role": "user",
            "content": (
                "[VALIDATION-ERROR] Your last phase_output failed "
                f"validation: {validation_error}. Re-submit the receipt "
                "with the correct shape."
            ),
        }
    phase = validation_error.get("phase") or "?"
    reason = validation_error.get("reason") or "shape did not match the required schema"
    parts = [
        f"[VALIDATION-ERROR] Your last {phase} phase_output failed validation.",
        f"Reason: {reason}",
    ]
    details = validation_error.get("details") or []
    if isinstance(details, list) and details:
        parts.append("Per-field errors:")
        for d in details[:10]:  # cap so a verbose error doesn't blow the prompt
            if isinstance(d, dict):
                loc = d.get("loc") or d.get("field") or "?"
                # M87 — `issue` is the key validators.py actually uses;
                # `msg`/`message` are kept for back-compat with any
                # legacy producer. Without `issue` in the lookup the
                # renderer was falling through to `str(d)` and dumping
                # the raw dict at the model.
                msg = d.get("issue") or d.get("msg") or d.get("message") or str(d)
                parts.append(f"  - {loc}: {msg}")
            else:
                parts.append(f"  - {d}")
    # M87 — phase-clarity nudge. Repro from develop attempt 93af88cb:
    # after two REPAIR validation rejections, the model's next-turn
    # thinking block read "I'm in VERIFY phase now and the previous
    # REPAIR phase output was invalid…" — it interpreted the bounce as
    # forward progress and called a VERIFY-only tool, which the gateway
    # refused. The state machine never moved (validation_error does NOT
    # advance phase), so explicitly say so.
    parts.append(
        f"You are STILL in the {phase} phase — a validation error does NOT "
        f"advance the phase. Do NOT call tools that are forbidden in {phase}. "
        "Call submit_phase_output again with the same phase_output corrected."
    )
    parts.append(
        "You have one retry attempt before the stage aborts with "
        "VALIDATION_BLOCKED."
    )
    return {"role": "user", "content": "\n".join(parts)}


_MUTATING_PHASES = {Phase.ACT, Phase.REPAIR}


# M83.y P3 (2026-05-27) — tools that count as "acting" in ACT/REPAIR.
# Reads (read_file, list_files, etc.) explicitly do NOT count: in a
# mutating phase, an agent that only reads is still narrating. The
# bounce predicate below uses this set to catch the "I read the file
# and diagnosed it, let me fix this:" failure where the model emits
# substantive text but no actual mutation tool call.
#
# The list is conservative — anything that writes to the workspace,
# runs tests/build, or persists git state counts as acting. New
# mutating tools added downstream just need to land here too.
_ACT_FULFILLING_TOOLS = frozenset({
    "apply_patch",
    "replace_text",
    "write_file",
    "create_file",
    "delete_file",
    "move_file",
    "run_test",
    "run_command",
    "finish_work_branch",
    "git_commit",
    "git_push",
})

# Minimum length of stripped assistant text that counts as "substantive
# narration" for the read-then-narrate bounce. Short acknowledgements
# like "ok" or "let me check" are ambient; we only bounce when the
# model is clearly building up to action without taking it. 80 chars
# (~15 words) is the empirical floor — diagnostic prose always clears
# this, and the "Let me fix this:" pattern from the screenshot
# (~480 chars) trips it cleanly.
_NARRATE_TEXT_THRESHOLD = 80


# M86 — Default per-phase turn budgets. The stage-wide max_turns (default
# 25) is too coarse: an agent that spends 28 turns reading files in
# EXPLORE never reaches ACT, fails MAX_TURNS, produces zero edits, and
# the M83.y P2 auto-remediation can't help (no code change to classify).
# Per-phase caps force the loop to advance. Override per stage via
# StagePolicy.limits.max_turns_per_phase (a dict in JSON).
#
# Sized empirically for a single develop attempt:
#   PLAN         5  — task pack synthesis from prior receipts, mostly
#                      a writing exercise once the plan is clear.
#   EXPLORE      10 — file reads + symbol search; deeper exploration
#                      is usually a sign of bad starting context, not
#                      a need for more turns.
#   ACT          8  — the actual edits; tightly bounded.
#   VERIFY       5  — run_test + capture results; 1-3 commands typical.
#   REPAIR       8  — same shape as ACT plus the diagnosis.
#   SELF_REVIEW  3  — produce a SelfReviewReceipt; no tools needed.
#   FINALIZE     2  — submit the final pack; near-zero tool calls.
#
# Hard halt at 2x: PLAN at 10 turns, EXPLORE at 20, etc. The mid-cap
# nudge fires once; if the model ignores it and burns another cap-worth
# of turns without advancing, the stage halts with stop_reason
# PHASE_BUDGET_EXCEEDED so the operator gets a clean signal.
_DEFAULT_MAX_TURNS_PER_PHASE: dict[str, int] = {
    "PLAN":        5,
    "EXPLORE":     10,
    "ACT":         8,
    "VERIFY":      5,
    "REPAIR":      8,
    "SELF_REVIEW": 3,
    "FINALIZE":    2,
}


def _resolve_phase_budget(policy: StagePolicy, phase: Phase) -> int:
    """Per-phase turn cap. Falls back to defaults when policy doesn't
    pin a value for this phase. Returns 0 to mean "no per-phase cap"
    (stage-wide max_turns is the only limit)."""
    limits = policy.limits if policy and isinstance(policy.limits, dict) else {}
    per_phase = limits.get("max_turns_per_phase")
    if isinstance(per_phase, dict):
        # M90.D (2026-05-27) — the original wrote "explicit 0/null
        # disables the per-phase cap" then fell through to the default
        # anyway. The contract is now honored: explicit 0 disables;
        # MISSING (key not in dict) inherits the default.
        if phase.value in per_phase:
            raw = per_phase[phase.value]
            if isinstance(raw, int) and raw >= 0:
                return raw   # explicit value, including 0 = disable
            # Non-int / negative → fall through to default below.
    return _DEFAULT_MAX_TURNS_PER_PHASE.get(phase.value, 0)


def _render_phase_budget_message(
    state: PhaseState,
    turns_in_phase: int,
    budget: int,
) -> dict[str, Any]:
    """Forcing message when a phase exceeds its budget. Tells the
    model exactly what to do (submit phase_output) and what the
    consequence is (stage fails on the next cap). Operators can
    grep audit-gov for [PHASE-BUDGET-EXCEEDED] to find stuck stages."""
    phase = state.current_phase.value
    return {
        "role": "user",
        "content": (
            f"[PHASE-BUDGET-EXCEEDED] You have spent {turns_in_phase} turns in "
            f"phase {phase} (budget: {budget}). The loop expects you to "
            "submit_phase_output and advance by now. Whatever exploration "
            "you've done is enough — synthesize what you have and submit "
            "the receipt for this phase. On your VERY NEXT response, you "
            "MUST call submit_phase_output with the receipt for "
            f"{phase}. If you spend another {budget} turns in this phase "
            "without advancing, the stage will be halted with "
            "PHASE_BUDGET_EXCEEDED and the operator will see the failure."
        ),
    }


def _is_narrate_only_in_mutating_phase(
    state: PhaseState,
    turn,
) -> tuple[bool, str]:
    """Detect the two narrate-without-act variants in one place.

    Returns (should_bounce, variant) where variant is:
      - "empty"      → no tool calls AT ALL (original M70.x trigger)
      - "read-only"  → read tools ran but no mutation + substantive prose
                       (the "Let me fix this:" failure from M83.y P3)
      - ""           → no bounce needed
    """
    if state.current_phase not in _MUTATING_PHASES:
        return False, ""
    if turn.step.validation_error or turn.step.phase_advanced:
        return False, ""

    outcomes = turn.step.tool_outcomes or []
    if not outcomes:
        return True, "empty"

    # Has any successful mutating tool dispatch fired this turn?
    has_mutation = any(
        (o.allowed and o.tool_success and o.tool_name in _ACT_FULFILLING_TOOLS)
        for o in outcomes
    )
    if has_mutation:
        return False, ""

    # Tools ran but none of them mutated. Did the model emit substantive
    # narration? If yes → read-then-narrate bounce.
    assistant_text = ""
    llm_msg = getattr(turn, "llm", None) or {}
    if isinstance(llm_msg, dict):
        raw_content = llm_msg.get("content") or ""
        if isinstance(raw_content, str):
            assistant_text = raw_content.strip()
    if len(assistant_text) >= _NARRATE_TEXT_THRESHOLD:
        return True, "read-only"
    return False, ""


def _render_narrate_without_act_message(
    state: PhaseState,
    variant: str = "empty",
) -> dict[str, Any]:
    """Bounce the LLM when it emits assistant text in a mutating phase
    (ACT / REPAIR) without calling any tool or submit_phase_output.

    Failure mode this catches (repro: develop attempt 5b7c069c, 2026-05-26):
    the agent enters REPAIR, reads "VERIFY failed. Fix the regression",
    and replies with narration like "I need to move to REPAIR phase since
    there's a test failure that needs to be fixed. Let me submit the
    VERIFY phase output indicating failure, then move to REPAIR." The
    text is conversationally plausible but no tool fires and no receipt
    is submitted. The turn counts against max_turns; if it happens near
    the end of the budget the stage aborts immediately.

    The phase machine doesn't classify this as a validation_error (nothing
    was submitted to validate), so the existing validation-bounce path
    doesn't catch it. The stagnant-phase guard does eventually (3
    consecutive no-progress turns), but by then the budget is shot. This
    bounce is the early-warning version: one turn of narration in a
    mutating phase, immediately corrected.

    Read-only phases (PLAN / EXPLORE / VERIFY / SELF_REVIEW / FINALIZE)
    skip this — those phases sometimes legitimately emit a final summary
    text alongside submit_phase_output, or read-only exploration where
    no tool call is genuinely the right answer (rare but real).

    M83.y P3 (2026-05-27) — `variant` distinguishes the two failures
    this catches:
      - "empty": no tool calls fired at all (original trigger).
      - "read-only": read tools fired but no mutation, and the model
        wrote substantive prose (e.g. "I diagnosed the issue at line
        136 — Map.of() rejects nulls. Let me fix this:") without
        actually emitting apply_patch. The message is tailored to
        the symptom: "you've read enough, now patch."
    """
    phase = state.current_phase.value
    if variant == "read-only":
        return {
            "role": "user",
            "content": (
                f"[NARRATE-WITHOUT-ACT] You are in {phase}. Your last "
                "response read files and wrote prose explaining what "
                "you'd like to change, but you didn't actually emit a "
                "mutation tool call (apply_patch / replace_text / "
                "write_file / create_file) and you didn't submit a "
                "phase output. Reading and diagnosing is not enough — "
                f"{phase} requires the mutation itself in the same turn "
                "as the diagnosis, or a submit_phase_output that "
                "captures what you already changed. Take the patch you "
                "described and apply it now. Your next response MUST "
                "include either a mutating tool call OR "
                "submit_phase_output — prose alone is rejected."
            ),
        }
    return {
        "role": "user",
        "content": (
            f"[NARRATE-WITHOUT-ACT] You are in {phase} and your last "
            "response was text only — no tool call, no submit_phase_output. "
            f"{phase} is a mutating phase: you must either call an allowed "
            "tool (read_file, apply_patch, replace_text, run_test, etc.) "
            "OR call submit_phase_output with the receipt for this phase. "
            "Describing what you intend to do does not advance the loop. "
            "If the prior phase output covered the regression and you "
            "just need to submit a RepairReceipt, do that now. If you "
            "need to inspect a file first, call read_file. Either way, "
            "your next response MUST include a tool call."
        ),
    }


def _render_phase_deadline_message(state: PhaseState, turns_remaining: int) -> dict[str, Any]:
    """Nudge the model to close the current phase before max_turns.

    Cheaper models often treat a phase prompt's read-only tool allowlist as an
    invitation to keep exploring. Without a direct countdown they can spend the
    whole stage saying "I'll inspect one more thing" and never call the
    synthetic submit_phase_output tool. The phase-specific prompt already owns
    the exact payload shape; this message only adds the operational stop signal.
    """
    plural = "" if turns_remaining == 1 else "s"
    return {
        "role": "user",
        "content": (
            f"[PHASE-DEADLINE] You are still in {state.current_phase.value}. "
            f"You have {turns_remaining} turn{plural} left before this stage "
            "fails with MAX_TURNS. On your next response, call "
            "`submit_phase_output` with the required payload for the current "
            "phase. Do not call more exploration tools unless the phase output "
            "would be impossible without one final read."
        ),
    }


def _render_architect_close_message(state: PhaseState) -> dict[str, Any] | None:
    """Tell read-only Architect stages to close after useful exploration.

    Architect Plan/Design stages are handoff stages, not autonomous coding
    stages. In practice smaller models keep taking another read-only step even
    after repo_map/search_code has already identified enough targets. This
    nudge is intentionally narrow to ARCHITECT PLAN/EXPLORE so Developer and
    QA still get their normal exploration budgets.
    """
    if (state.agent_role or "").upper() != "ARCHITECT":
        return None
    if state.current_phase is Phase.PLAN:
        return {
            "role": "user",
            "content": (
                "[ARCHITECT-CLOSE] You have enough to produce the PLAN handoff "
                "if you can name likely files/symbols and risks. On your next "
                "response, call submit_phase_output for PLAN and advance to "
                "EXPLORE. Do not call detailed code-reading tools in PLAN."
            ),
        }
    if state.current_phase is Phase.EXPLORE:
        return {
            "role": "user",
            "content": (
                "[ARCHITECT-CLOSE] Stop exploring once you can name the "
                "implementation files, findings, solution outline, and gaps. "
                "On your next response, call submit_phase_output for EXPLORE "
                "and advance to SELF_REVIEW."
            ),
        }
    if state.current_phase is Phase.SELF_REVIEW:
        return {
            "role": "user",
            "content": (
                "[ARCHITECT-CLOSE] You are in SELF_REVIEW. Do not call more "
                "tools. On your next response, call submit_phase_output with "
                "recommended_for_approval, risk_summary, summary, "
                "acceptance_criteria_check, and verification_summary so the "
                "Workbench approval gate can open."
            ),
        }
    return None


def _latest_phase_receipt(state: PhaseState, phase: Phase) -> dict[str, Any] | None:
    receipts = state.receipts.get(phase.value) or []
    for receipt in reversed(receipts):
        if isinstance(receipt, dict):
            return receipt
    return None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            text = item.get("target") or item.get("file") or item.get("reason")
            if isinstance(text, str) and text.strip():
                out.append(text.strip())
    return out


def _render_verification_summary(plan_receipt: dict[str, Any] | None) -> str:
    if not isinstance(plan_receipt, dict):
        return "Developer and QA should run the repository's applicable tests after implementation."
    strategy = plan_receipt.get("test_strategy")
    if isinstance(strategy, dict):
        commands = _string_list(strategy.get("commands"))
        if commands:
            return f"Run verification after implementation: {', '.join(commands)}."
    return "Developer and QA should run the repository's applicable tests after implementation."


def _architect_self_review_fallback_receipt(state: PhaseState) -> dict[str, Any] | None:
    """Build an approval-handoff receipt when a read-only Architect stage
    reached SELF_REVIEW but failed to emit the final receipt before max_turns.

    This is intentionally narrow: it only runs for Architect SELF_REVIEW and
    only when PLAN or EXPLORE has already produced structured evidence. That
    preserves the human approval gate while avoiding a wasteful failure after
    the model has already identified implementation targets and risks.
    """
    if (state.agent_role or "").upper() != "ARCHITECT":
        return None
    if state.current_phase is not Phase.SELF_REVIEW:
        return None

    plan = _latest_phase_receipt(state, Phase.PLAN)
    explore = _latest_phase_receipt(state, Phase.EXPLORE)
    if plan is None and explore is None:
        return None

    target_files = _string_list((plan or {}).get("target_files"))
    target_files.extend(
        file for file in _string_list((explore or {}).get("updated_target_files"))
        if file not in target_files
    )
    findings = _string_list((explore or {}).get("implementation_findings"))
    outline = (explore or {}).get("solution_outline")
    if isinstance(outline, list):
        outline_text = "; ".join(_string_list(outline))
    elif isinstance(outline, str):
        outline_text = outline.strip()
    else:
        outline_text = ""

    risk_level = (plan or {}).get("risk_level")
    if risk_level not in {"low", "medium", "high"}:
        risk_level = "medium" if _string_list((explore or {}).get("gaps")) else "low"
    risks = _string_list((plan or {}).get("open_questions"))
    risks.extend(gap for gap in _string_list((explore or {}).get("gaps")) if gap not in risks)
    if not risks:
        risks = ["Developer must verify case-insensitive matching and null or empty input behavior."]

    summary_parts = ["Implementation plan is ready for Developer handoff."]
    if target_files:
        summary_parts.append(f"Target files: {', '.join(target_files)}.")
    if outline_text:
        summary_parts.append(f"Solution outline: {outline_text}")
    elif findings:
        summary_parts.append(f"Key findings: {'; '.join(findings[:4])}.")

    return {
        "kind": "self_review_receipt",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "summary": " ".join(summary_parts),
        "acceptance_criteria_check": [
            {
                "criterion": "Planning handoff identifies target implementation files, behavior, risks, and verification expectations.",
                "status": "met",
                "evidence": "PLAN/EXPLORE receipts were produced before SELF_REVIEW timed out.",
            }
        ],
        "risk_summary": {
            "risk_level": risk_level,
            "risks": risks,
            "rollback_notes": "No code has been changed in the Architect stage; rollback is not required.",
        },
        "diff_summary": {
            "files_changed": [],
            "lines_added": 0,
            "lines_deleted": 0,
            "notable_changes": ["Read-only Architect planning handoff; no repository mutation."],
        },
        "verification_summary": _render_verification_summary(plan),
        "recommended_for_approval": True,
        "fallback_reason": "Architect reached SELF_REVIEW with structured PLAN/EXPLORE evidence but did not emit the final self-review receipt before max_turns.",
    }


async def _try_architect_self_review_fallback(
    result: StageRunResult,
    state: PhaseState,
    run_context: dict[str, Any] | None,
) -> bool:
    receipt = _architect_self_review_fallback_receipt(state)
    if receipt is None:
        return False
    try:
        next_state = advance_phase(state, Phase.SELF_REVIEW, receipt=receipt)
    except ValueError as exc:
        await emit_governed_event(
            kind="governed.architect_self_review_fallback_failed",
            state=state,
            policy=None,
            run_context=run_context,
            payload={"reason": str(exc)},
            severity="warn",
        )
        return False

    result.final_state = next_state
    result.stop_reason = "APPROVAL_PENDING"
    await emit_governed_event(
        kind="governed.architect_self_review_fallback",
        state=next_state,
        policy=None,
        run_context=run_context,
        payload={
            "reason": receipt["fallback_reason"],
            "receipt_kind": receipt["kind"],
        },
        severity="warn",
    )
    return True


def _render_eval_feedback_message(feedback: Any) -> dict[str, Any] | None:
    """M74 Phase 2B — render audit-gov's EvalFeedback shape as a user-
    role message that lands in the FIRST turn's prompt. Returns None
    when feedback is missing/empty (no closed-loop signal to inject).

    Expected shape (matches audit-gov's getLatestEvalFeedbackForSession
    response, see audit-governance-service/src/engine/evaluator-factory.ts):

        {
          "eval_run_id": "...",
          "status": "FAILED",
          "pass_rate": 0.4,
          "created_at": "...",
          "metadata": { "stageKey": "...", "attempt": 2 },
          "failing_results": [
            { "evaluator_kind": "llm_judge", "score": 2,
              "reason": "<text>", "evidence": {...} },
            ...
          ]
        }

    Defensive: accepts None, non-dict, or empty failing_results — all
    return None so the caller can no-op silently on first-attempt
    or schema mismatch.
    """
    if not isinstance(feedback, dict):
        return None
    failing = feedback.get("failing_results")
    if not isinstance(failing, list) or not failing:
        return None

    parts = [
        "[QUALITY-GATE FEEDBACK] The previous attempt of this stage was "
        f"blocked by the eval gate (pass_rate={feedback.get('pass_rate', 0)}, "
        f"eval_run_id={feedback.get('eval_run_id', 'unknown')}).",
        "",
        "Failing evaluator results:",
    ]
    # Cap at top 5 to keep the prompt addition bounded. The full list
    # remains accessible via the eval_run_id for ops follow-up.
    for entry in failing[:5]:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("evaluator_kind") or "unknown"
        score = entry.get("score")
        reason = (entry.get("reason") or "").strip() or "(no reason text)"
        score_str = f"score={score}" if score is not None else "score=n/a"
        parts.append(f"  • {kind} [{score_str}]: {reason[:600]}")

    if len(failing) > 5:
        parts.append(f"  • … and {len(failing) - 5} more (see eval_run_id for full detail)")

    parts.append("")
    parts.append(
        "Take this feedback into account. If the previous failure mode "
        "was a specific missing case, a wrong assumption, or an unhandled "
        "edge, address it explicitly in this attempt. Do NOT re-emit the "
        "same output that already failed."
    )
    return {"role": "user", "content": "\n".join(parts)}


def _is_terminal_state(state: PhaseState) -> bool:
    """The stage is done when the machine reaches FINALIZE.

    (2026-05-26 revised) Earlier we tried to require a FinalizeReceipt
    in the FINALIZE bucket before terminating — to force the agent to
    take a turn in FINALIZE and call finish_work_branch. That broke
    in practice: the agent kept submitting non-FINALIZE phase outputs
    while in FINALIZE phase, the loop kept iterating, eventually hit
    MAX_TURNS without ever calling the tool — and worse, when the
    workgraph re-invoked governed-execute it restarted the loop from
    PLAN (see session 5f95ad4b dev attempt 68195c30: two full cycles,
    56 LLM calls, zero finish_work_branch dispatches).

    Reverting to the simpler "FINALIZE = terminal" semantics. The
    finish_work_branch behavior is enforced one level up by the
    blueprint.router's finishWorkBranchInvoked guard (f538875 +
    scoped in 96c01d4) — it marks the stage FAILED when the tool
    wasn't actually called. The right answer to "agent never calls
    finish_work_branch" is to fix the FINALIZE prompt's pre-flight
    instructions (call the tool BEFORE submitting submit_phase_output)
    rather than to block loop termination on it.
    """
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


def _is_transient_llm_error(exc: LLMGatewayError) -> bool:
    """Return True when retrying the same LLM turn is likely to help.

    Provider disconnects and 5xx responses have shown up in Workbench runs as
    otherwise-healthy stages failing permanently. Retrying inside the driver
    preserves the stage attempt and avoids burning one of the user's limited
    Workbench loop attempts on infrastructure noise. 4xx request-shape errors
    stay non-retryable because the next identical call would fail the same way.
    """
    if exc.error_code not in _TRANSIENT_LLM_ERROR_CODES:
        return False
    if exc.upstream_status is None:
        return True
    return exc.upstream_status in {429, 500, 502, 503, 504}


# ─────────────────────────────────────────────────────────────────────────────
# M96 — salvage path for a productive-but-unpackaged mutating phase.
#
# Failure class (repro: develop attempt 3f8db8d7, work item WRK-DCA8D): the
# agent dispatched real, correct mutating tools (apply_patch / replace_text /
# …) — `state.produced_code_changes` is populated with confirmed
# code_change_ids — but never submitted a VALID EditReceipt, so it never
# advanced out of ACT. Every existing guard (validation-retry budget, stagnant
# detector, narrate-without-act bounce, per-phase turn budget) is a NUDGE that,
# once exhausted, HALTS the stage FAILED and DISCARDS the correct edits. The
# operator then re-runs from scratch and the agent re-derives the same diff.
#
# Salvage closes that hole honestly. When a mutating phase is about to halt
# FAILED but the agent demonstrably produced code changes, the orchestrator:
#   (a) synthesizes the EditReceipt the agent should have submitted, from the
#       OBSERVED tool outcomes (state.produced_code_changes — the same
#       provenance the loop.py ACT→VERIFY check trusts);
#   (b) runs the REAL verifier on those edits (synthesize_verifier_run — the
#       same external oracle the happy path uses, never fabricated);
#   (c) routes the verified result forward:
#         • verifier PASSED      → advance to SELF_REVIEW with
#                                  recommended_for_approval=True →
#                                  stop_reason APPROVAL_PENDING. The human gate
#                                  still opens; we NEVER auto-finalize.
#         • verifier FAILED      → stay in VERIFY, stop_reason
#                                  SALVAGED_VERIFY_FAILED (FAILED status, but
#                                  the edits + verifier evidence are persisted
#                                  for the next attempt / human review).
#         • verifier UNAVAILABLE → stay in VERIFY, stop_reason
#                                  SALVAGED_VERIFY_UNAVAILABLE.
#
# Everything synthesized here is tagged `salvaged: true` so the audit trail and
# Workbench never pretend the AGENT packaged it — the ORCHESTRATOR did, from
# real observed outcomes. New stop_reasons default to FAILED in workgraph-api's
# adapter (only FINALIZED/APPROVAL_PENDING/NOT_ACTIONABLE map to COMPLETED), so
# a salvaged-but-unverified stage can never masquerade as a clean pass.
# ─────────────────────────────────────────────────────────────────────────────


def _salvageable_changed_paths(state: PhaseState) -> list[str]:
    """Normalised file paths that carry at least one bound code_change_id.

    `produced_code_changes` maps normalised path → list[code_change_id],
    accumulated by governed_step's dispatch wrapper on every SUCCESSFUL
    mutating-tool outcome. A non-empty value is hard provenance that a real
    edit landed against that path — exactly the evidence a hand-written
    EditReceipt would need to pass the loop.py ACT→VERIFY provenance check.
    """
    out: list[str] = []
    for path, change_ids in (state.produced_code_changes or {}).items():
        if not isinstance(path, str) or not path.strip():
            continue
        if change_ids:  # ≥1 bound code_change_id = confirmed mutation
            out.append(path.strip())
    return out


def _synthesize_edit_receipt(paths: list[str]) -> dict[str, Any]:
    """Build the EditReceipt the agent SHOULD have submitted, from observed
    mutating-tool outcomes. Shape matches receipts.EditReceipt (edits[]
    min_length=1; edit_type ∈ the allowed enum)."""
    return {
        "kind": "edit_receipt",
        "edits": [
            {
                "file": p,
                "edit_type": "apply_patch",
                "reason": (
                    "Salvaged by the orchestrator from observed mutating-tool "
                    "outcomes — the agent edited this file (confirmed "
                    "code_change_id provenance) but did not package a valid "
                    "EditReceipt before its budget was exhausted."
                ),
            }
            for p in paths
        ],
        "skipped_targets": [],
        "salvaged": True,
        "summary": (
            f"Orchestrator-salvaged EditReceipt covering {len(paths)} file(s) "
            "with confirmed code-change provenance."
        ),
    }


def _synthesize_verification_receipt(synth: SyntheticVerifierResult) -> dict[str, Any]:
    """Map a SyntheticVerifierResult onto a VerificationReceipt dict
    (receipts.VerificationReceipt → .verification_result).

      ran + tool_success   → status=passed  (exit_code forced to 0 so the
                              VerificationResultPayload validator's
                              "passed ⇒ all exit codes 0" rule holds)
      ran + not tool_success → status=failed
      skipped / unavailable  → status=unavailable (reason mandatory)
    commands_run is non-empty for passed/failed (validator requires it).
    """
    if synth.kind == "ran":
        passed = bool(synth.tool_success)
        command_result = {
            "command": synth.command or "(salvaged verifier command)",
            "exit_code": 0 if passed else (
                synth.exit_code if isinstance(synth.exit_code, int) and synth.exit_code != 0 else 1
            ),
            "duration_ms": synth.duration_ms or 0,
            "stdout_summary": synth.stdout_summary or "",
            "stderr_summary": synth.stderr_summary or "",
        }
        return {
            "kind": "verification_receipt",
            "verification_result": {
                "status": "passed" if passed else "failed",
                "commands_run": [command_result],
                "salvaged": True,
            },
        }
    reason = synth.reason or "orchestrator could not run a verifier on the salvaged edits"
    return {
        "kind": "verification_receipt",
        "verification_result": {
            "status": "unavailable",
            "commands_run": [],
            "reason": reason,
            "salvaged": True,
        },
    }


def _synthesize_self_review_receipt(
    *, passed: bool, paths: list[str]
) -> dict[str, Any]:
    """Build a SelfReviewReceipt dict. recommended_for_approval mirrors the
    verifier verdict; acceptance_criteria_check is left empty so the
    SelfReviewReceipt validator's not_met/uncertain guard can't trip — the
    HUMAN approval gate (which this opens) is the binding decision."""
    return {
        "kind": "self_review_receipt",
        "summary": (
            "Orchestrator-salvaged self review. The agent produced verified code "
            "changes but did not complete SELF_REVIEW within budget; the "
            "orchestrator packaged the observed edits and the verifier result for "
            "human approval."
        ),
        "acceptance_criteria_check": [],
        "risk_summary": {
            "risk_level": "medium",
            "risks": [
                "Receipt synthesized by the orchestrator rather than the agent — "
                "review the diff before approving."
            ],
            "rollback_notes": None,
        },
        "diff_summary": {
            "files_changed": list(paths),
            "lines_added": 0,
            "lines_deleted": 0,
            "notable_changes": [],
        },
        "verification_summary": (
            "Verifier passed on the salvaged edits."
            if passed
            else "Verifier did not pass on the salvaged edits."
        ),
        "recommended_for_approval": bool(passed),
        "salvaged": True,
    }


def _synthetic_verifier_turn(
    synth: SyntheticVerifierResult,
    *,
    from_phase: str,
    turn_idx: int,
) -> dict[str, Any]:
    """A turns[] entry carrying the salvaged verifier outcome in the SAME
    tool_outcome envelope shape workgraph-api's adapter harvests verification
    receipts from (orchestrator.ts: kind=='verification_result' OR
    tool_name=='run_test'). Marked `salvaged`+`synthetic` so audit/UI can
    distinguish it from an agent-dispatched run_test."""
    ran = synth.kind == "ran"
    passed = bool(ran and synth.tool_success)
    result_envelope: dict[str, Any] = {
        "kind": "verification_result",
        "id": synth.tool_invocation_id,
        "command": synth.command,
        "passed": passed,
        "exit_code": synth.exit_code if isinstance(synth.exit_code, int) else (0 if passed else 1),
        "unavailable": not ran,
        "stdout_excerpt": (synth.stdout_summary or "")[:4000],
        "stderr_excerpt": (synth.stderr_summary or "")[:4000],
        "salvaged": True,
        "synthetic": True,
        "reason": synth.reason,
    }
    outcome = {
        "tool_name": "run_test",
        "phase": Phase.VERIFY.value,
        "allowed": True,
        "refusal_reason": None,
        "allowed_tools": None,
        "result": result_envelope,
        "duration_ms": synth.duration_ms,
        "tool_invocation_id": synth.tool_invocation_id,
        "tool_success": passed,
        "tool_error": None if ran else (synth.reason or "verifier unavailable"),
        "dispatch_error": None,
    }
    return {
        "turn_index": turn_idx,
        "from_phase": from_phase,
        "to_phase": Phase.VERIFY.value,
        "phase_advanced": True,
        "tool_outcomes": [outcome],
        "validation_error": None,
        "llm": {},
        "prompt": None,
        "salvaged": True,
    }


async def _salvage_mutating_phase(
    result: StageRunResult,
    state: PhaseState,
    *,
    stage_policy: StagePolicy | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
    turn_idx: int,
    trigger: str,
) -> bool:
    """M96 — last-resort salvage for a mutating phase about to halt FAILED.

    Returns True when the salvage fired — the caller MUST `return result`
    immediately (stop_reason + final_state are already set). Returns False when
    there's nothing to salvage (current phase isn't mutating, or no observed
    code changes, or the forced transition is refused), in which case the
    caller falls through to its original FAILED halt.
    """
    if state.current_phase not in _MUTATING_PHASES:
        return False
    paths = _salvageable_changed_paths(state)
    if not paths:
        return False

    from_phase = state.current_phase.value
    edit_receipt = _synthesize_edit_receipt(paths)

    # Run the REAL verifier on the observed edits — same external oracle the
    # happy path uses. Documented as never-raising; the except is defensive.
    try:
        synth = await synthesize_verifier_run(
            edit_receipt,
            work_item_id=(run_context or {}).get("work_item_id")
            or (run_context or {}).get("workItemId"),
            workspace_id=(run_context or {}).get("workspace_id")
            or (run_context or {}).get("workspaceId"),
            run_context=run_context,
            bearer=bearer,
            policy=stage_policy,
            phase=state.current_phase,
        )
    except Exception as exc:  # pragma: no cover — synthesize never raises
        log.warning("salvage: verifier synthesis raised (defensive): %s", exc)
        synth = SyntheticVerifierResult(
            kind="unavailable", reason=f"orchestrator error: {exc!s}"
        )

    ran = synth.kind == "ran"
    passed = bool(ran and synth.tool_success)

    # 1. ACT/REPAIR → VERIFY with the salvaged EditReceipt.
    try:
        state = advance_phase(state, Phase.VERIFY, receipt=edit_receipt)
    except ValueError as exc:
        # Transition refused (e.g. repair-attempt cap). Can't salvage cleanly;
        # leave the caller's FAILED halt in place.
        log.warning("salvage: %s→VERIFY refused: %s", from_phase, exc)
        return False

    # 2. Record the synthetic verifier turn so workgraph-api harvests the
    #    verification receipt from the tool_outcome stream.
    result.turns.append(
        # from_phase is the REAL originating mutating phase (ACT/REPAIR), not VERIFY —
        # the synthetic turn records the salvage transition <mutating>→VERIFY. Passing
        # Phase.VERIFY.value here made the trace falsely report VERIFY→VERIFY.
        _synthetic_verifier_turn(synth, from_phase=from_phase, turn_idx=turn_idx + 1)
    )
    result.total_tool_calls += 1

    verification_receipt = _synthesize_verification_receipt(synth)

    if passed:
        # 3a. VERIFY → SELF_REVIEW (verification receipt), then SELF_REVIEW
        #     self-loop with recommended_for_approval=True so approval_pending
        #     flips and the human gate opens. We never auto-advance to FINALIZE.
        state = advance_phase(state, Phase.SELF_REVIEW, receipt=verification_receipt)
        state = advance_phase(
            state,
            Phase.SELF_REVIEW,
            receipt=_synthesize_self_review_receipt(passed=True, paths=paths),
        )
        result.stop_reason = "APPROVAL_PENDING"
        salvage_outcome = "approval_pending"
    else:
        # 3b. Verifier didn't pass — stay in VERIFY, persist the evidence.
        #     Distinct stop_reason so operators see WHY (still FAILED status in
        #     workgraph-api, but the edits + verifier output are saved).
        state = advance_phase(state, Phase.VERIFY, receipt=verification_receipt)
        if ran:
            result.stop_reason = "SALVAGED_VERIFY_FAILED"
            salvage_outcome = "verify_failed"
        else:
            result.stop_reason = "SALVAGED_VERIFY_UNAVAILABLE"
            salvage_outcome = "verify_unavailable"

    result.final_state = state

    await emit_governed_event(
        kind="governed.phase_salvaged",
        state=state,
        policy=stage_policy,
        run_context=run_context,
        payload={
            "trigger": trigger,
            "from_phase": from_phase,
            "salvaged_paths": paths,
            "verifier_kind": synth.kind,
            "verifier_passed": passed,
            "outcome": salvage_outcome,
            "stop_reason": result.stop_reason,
            "turn_idx": turn_idx,
        },
        severity="warn",
    )
    log.warning(
        "phase salvaged: trigger=%s from_phase=%s paths=%d verifier=%s passed=%s → %s",
        trigger, from_phase, len(paths), synth.kind, passed, result.stop_reason,
    )
    return True


# M99 S1.1 — sentinel key for the localization receipt in state.receipts.
# Mirrors baseline_diff.BASELINE_STASH_KEY: double-underscore-wrapped so
# receipt readers that iterate phase buckets skip it, and it rides the
# existing to_dict/from_dict persistence without a schema change. Stored as
# a single-element list to match the dict[str, list[dict]] receipts shape.
_LOCALIZATION_KEY = "__localization__"


async def _maybe_run_localization(
    *,
    state: PhaseState,
    vars: dict[str, Any] | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
    exec_policy: StageExecutionPolicy | None,
    stage_policy: StagePolicy | None,
) -> None:
    """M99 S1.1 — run the deterministic pre-ACT localization sweep once.

    No-op unless automation_enabled(exec_policy, "localize") — i.e. BOTH
    CF_AGENTIC_CODING_V2_ENABLED and exec_policy.auto_localize are on
    (OFF by default → strict no-op in Phase 0).

    On run, stashes a LocalizationReceipt dict under the `__localization__`
    sentinel in state.receipts (the receipts dict is mutable even though
    PhaseState is frozen — same pattern as baseline_diff.stash_baseline)
    and — when targets were found — injects it into `vars` for prompt
    rendering. Emits governed.localization_completed. NEVER raises: a failed
    sweep is logged and the stage proceeds unchanged (shadow mode).
    """
    if not automation_enabled(exec_policy, "localize"):
        return
    try:
        _v = vars or {}
        loc_task: str | None = None
        if isinstance(_v.get("goal"), str):
            loc_task = _v["goal"]
        elif isinstance(_v.get("task"), str):
            loc_task = _v["task"]
        _rc = run_context or {}
        cap = _rc.get("capability_id") or _rc.get("capabilityId")
        wid = _rc.get("work_item_id") or _rc.get("workItemId")
        wsid = _rc.get("workspace_id") or _rc.get("workspaceId")
        loc_result = await synthesize_localization(
            task_text=loc_task,
            capability_id=cap,
            work_item_id=wid,
            workspace_id=wsid,
            run_context=run_context,
            bearer=bearer,
            policy=stage_policy,
            phase=state.current_phase,
        )
        receipt_dict = LocalizationReceipt(
            **loc_result.to_receipt_payload()
        ).model_dump(mode="json")
        # Persist under the sentinel (in-place mutation of the mutable
        # receipts dict; PhaseState itself is frozen).
        state.receipts[_LOCALIZATION_KEY] = [receipt_dict]
        if loc_result.found_anything and vars is not None:
            # Advisory until S3.2 bakes it into the ACT template; templates
            # that don't reference it simply ignore the var.
            vars["localization_receipt"] = receipt_dict
            vars["localization_summary"] = loc_result.summary or ""
        await emit_governed_event(
            kind="governed.localization_completed",
            state=state,
            policy=stage_policy,
            run_context=run_context,
            payload={
                "found": loc_result.found_anything,
                "files": len(loc_result.target_files),
                "symbols": len(loc_result.target_symbols),
                "tests": len(loc_result.target_tests),
                "sources": loc_result.sources,
                "reason": loc_result.reason,
            },
            severity="info" if loc_result.found_anything else "warn",
        )
    except Exception as exc:  # pragma: no cover — defensive; shadow must never break the stage
        log.warning("M99 localization sweep failed (non-fatal): %s", exc)


# M99 S1.3 — sentinel key for the git-preflight receipt in state.receipts.
# Same double-underscore convention as _LOCALIZATION_KEY / BASELINE_STASH_KEY
# so phase-bucket readers skip it.
_GIT_PREFLIGHT_KEY = "__git_preflight__"


async def _maybe_run_git_preflight(
    *,
    state: PhaseState,
    vars: dict[str, Any] | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
    exec_policy: StageExecutionPolicy | None,
    stage_policy: StagePolicy | None,
) -> None:
    """M99 S1.3 — run the git push preflight once per attempt (shadow).

    No-op unless automation_enabled(exec_policy, "preflight") — i.e. BOTH
    CF_GIT_PREFLIGHT_ENABLED and exec_policy.git_preflight_required are on
    (OFF by default). On run, dispatches the git_push_preflight tool, stashes
    a GitPreflightReceipt under the `__git_preflight__` sentinel, and — when a
    block is detected — injects it into vars for visibility. SHADOW: never
    blocks the stage. NEVER raises.
    """
    if not automation_enabled(exec_policy, "preflight"):
        return
    try:
        _rc = run_context or {}
        branch = (
            _rc.get("branch_name")
            or _rc.get("branchName")
            or _rc.get("workitem_branch")
            or _rc.get("workitemBranch")
        )
        remote = _rc.get("remote")
        wid = _rc.get("work_item_id") or _rc.get("workItemId")
        wsid = _rc.get("workspace_id") or _rc.get("workspaceId")
        pf = await synthesize_git_preflight(
            branch=branch,
            remote=remote,
            work_item_id=wid,
            workspace_id=wsid,
            run_context=run_context,
            bearer=bearer,
            policy=stage_policy,
            phase=state.current_phase,
        )
        receipt_dict = GitPreflightReceipt(**pf.to_receipt_payload()).model_dump(mode="json")
        state.receipts[_GIT_PREFLIGHT_KEY] = [receipt_dict]
        if not pf.ok and vars is not None:
            vars["git_preflight_receipt"] = receipt_dict
        await emit_governed_event(
            kind="governed.git_preflight_completed",
            state=state,
            policy=stage_policy,
            run_context=run_context,
            payload={
                "ok": pf.ok,
                "blocked_code": pf.blocked_code,
                "branch": pf.branch,
                "remote": pf.remote,
                "reason": pf.reason,
            },
            severity="info" if pf.ok else "warn",
        )
    except Exception as exc:  # pragma: no cover — defensive; shadow must never break the stage
        log.warning("M99 git preflight failed (non-fatal): %s", exc)


async def _maybe_run_auto_baseline(
    *,
    state: PhaseState,
    run_context: dict[str, Any] | None,
    bearer: str | None,
    exec_policy: StageExecutionPolicy | None,
    stage_policy: StagePolicy | None,
) -> None:
    """M99 S2.1 — capture a pre-mutation test baseline once per attempt.

    No-op unless automation_enabled(exec_policy, "baseline") — i.e. BOTH
    CF_AUTO_BASELINE_ENABLED and exec_policy.auto_baseline are on (OFF by
    default). When on, runs BEFORE the turn loop (hence before any ACT
    mutation), stashes the baseline into state.receipts via
    baseline_diff.stash_baseline (so the existing post-edit
    enrich_verification_receipt path works unchanged) AND persists a
    BaselineReceipt under the `__baseline__` sentinel's sibling
    `baseline_receipt` slot. Idempotent (baseline_diff keeps the first).
    NEVER raises.

    This makes the spec's "capture_test_baseline is automatically called
    before the first mutating tool" claim TRUE — pre-M99 it was reactive
    (loop.py only stashed IF the agent dispatched the tool).
    """
    if not automation_enabled(exec_policy, "baseline"):
        return
    # Don't re-baseline if the agent (or a prior call) already did.
    if state.receipts.get(BASELINE_STASH_KEY):
        return
    try:
        _rc = run_context or {}
        wid = _rc.get("work_item_id") or _rc.get("workItemId")
        wsid = _rc.get("workspace_id") or _rc.get("workspaceId")
        result = await synthesize_baseline(
            state_receipts=state.receipts,
            work_item_id=wid,
            workspace_id=wsid,
            run_context=run_context,
            bearer=bearer,
            policy=stage_policy,
            phase=state.current_phase,
        )
        receipt_dict = BaselineReceipt(**result.to_receipt_payload()).model_dump(mode="json")
        # Persist the receipt alongside the stash (distinct sentinel so the
        # stash's own shape — used by enrich_verification_receipt — is
        # untouched).
        state.receipts[_BASELINE_RECEIPT_KEY] = [receipt_dict]
        await emit_governed_event(
            kind="governed.auto_baseline_completed",
            state=state,
            policy=stage_policy,
            run_context=run_context,
            payload={
                "captured": result.captured,
                "failing_tests": len(result.failing_tests),
                "commands_run": result.commands_run,
                "reason": result.reason,
            },
            severity="info" if result.captured else "warn",
        )
    except Exception as exc:  # pragma: no cover — defensive; must never break the stage
        log.warning("M99 auto-baseline failed (non-fatal): %s", exc)


# M99 S2.1 — sentinel for the BaselineReceipt. Distinct from baseline_diff's
# BASELINE_STASH_KEY ("__baseline__"), which holds the raw diff-stash shape;
# this holds the structured receipt for audit/UI.
_BASELINE_RECEIPT_KEY = "__baseline_receipt__"


# ── Capability Governance Model — enforcement gate (G4) ──────────────────────

def _satisfied_evidence_keys(state: PhaseState) -> set[str]:
    """Evidence keys that have a satisfying receipt in state.receipts. Best-effort
    + fail-closed: a receipt counts only when it records an evidence_key AND a
    passing status. (Richer receiptType→evidenceKey mapping lands with evidence
    submission; until then, unsatisfied evidence simply blocks — and is waivable.)"""
    out: set[str] = set()
    receipts = getattr(state, "receipts", {}) or {}
    for bucket in receipts.values():
        if not isinstance(bucket, list):
            continue
        for r in bucket:
            if not isinstance(r, dict):
                continue
            key = r.get("evidence_key") or r.get("evidenceKey")
            status = str(r.get("status") or "").lower()
            ok = r.get("tool_success") is True or status in ("passed", "pass", "ok", "satisfied")
            if isinstance(key, str) and key and ok:
                out.add(key)
    return out


def _evaluate_governance_block(
    overlay: dict[str, Any],
    satisfied_evidence: set[str],
    waived_controls: set[str],
) -> list[dict[str, Any]]:
    """Return the unsatisfied REQUIRED/BLOCKING governance controls (empty ⇒ the
    stage may promote). Fail-closed: a REQUIRED/BLOCKING evidence or a
    blockingControl blocks unless its key is satisfied or waived. ADVISORY
    contributes nothing — the gate is a no-op for advisory overlays."""
    if not isinstance(overlay, dict):
        return []
    blocked: list[dict[str, Any]] = []
    default_mode = str(overlay.get("effectiveMode") or "ADVISORY").upper()
    for ev in overlay.get("requiredEvidence") or []:
        if not isinstance(ev, dict):
            continue
        mode = str(ev.get("mode") or default_mode).upper()
        if mode not in ("REQUIRED", "BLOCKING"):
            continue
        key = ev.get("evidenceKey")
        if isinstance(key, str) and key and key not in satisfied_evidence and key not in waived_controls:
            blocked.append({"controlKey": key, "kind": "evidence", "mode": mode,
                            "reason": f"required evidence '{key}' not satisfied",
                            "stageKey": ev.get("stageKey"), "waivable": True})
    for c in overlay.get("blockingControls") or []:
        if not isinstance(c, dict):
            continue
        key = c.get("controlKey")
        if isinstance(key, str) and key and key not in satisfied_evidence and key not in waived_controls:
            blocked.append({"controlKey": key, "kind": "control", "mode": "BLOCKING",
                            "reason": c.get("reason") or f"blocking control '{key}' not satisfied",
                            "sourceCapabilityId": c.get("sourceCapabilityId"), "waivable": True})
    return blocked


async def run_stage(
    *,
    state: PhaseState,
    stage_key: str,
    agent_role: str | None,
    vars: dict[str, Any] | None = None,
    initial_history: list[dict[str, Any]] | None = None,
    model_alias: str | None = None,
    # M100 — per-phase model override map (Phase value → model alias),
    # threaded verbatim to every run_turn() so each phase of the stage
    # can route to a different model. None → single stage model (legacy).
    phase_model_aliases: dict[str, str] | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
    max_turns: int = DEFAULT_MAX_TURNS,
    history_recent_turns: int = DEFAULT_RECENT_TURNS,
    # M83.r — Anthropic extended thinking budget (tokens). None / 0 →
    # off. Default is None at this layer; the workgraph-api caller
    # picks the value based on env (DEEP_REASONING_BUDGET_TOKENS) and
    # whether the resolved model is Anthropic Claude 4+. Pass-through
    # to every run_turn() invocation in this stage.
    thinking_budget: int | None = None,
    # M91.A — workflow-resolved policy override. Threaded to every
    # run_turn() call so the per-turn tool descriptor list is
    # filtered consistently across the stage. See
    # stage_execution_policy.py for the override semantics.
    exec_policy: StageExecutionPolicy | None = None,
    # Capability Governance Model (G4) — resolved governance overlay (from IAM via
    # workgraph) + the active waiver control keys for this run. When the overlay
    # is BLOCKING/REQUIRED, the enforcement gate halts promotion with
    # GOVERNANCE_BLOCKED unless the controls are satisfied or waived. None/ADVISORY
    # ⇒ no enforcement (legacy behavior). The overlay is also threaded to run_turn
    # so its advisory guidance lands in every turn's prompt.
    governance_overlay: dict[str, Any] | None = None,
    governance_waivers: list[str] | None = None,
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

    # M92.B — Story Intake / no-repo short-circuit. When the workflow's
    # StageExecutionPolicy declares `repo_access=False` (canonical case:
    # PRODUCT_OWNER intake with context_policy=STORY_ONLY + tool_policy=NONE),
    # propagate that signal into the run_context so mcp-server's /mcp/tool-run
    # skips ensureWorkspaceSource() + indexWorkspace() entirely. Even though
    # CF's tool gateway already filters the allowlist to non-repo categories,
    # mcp-server still tried to clone+materialise on every dispatch — a slow
    # no-op on a story stage that has no source repo URI at all. This makes
    # the intent explicit at the wire level so the executor doesn't guess.
    if exec_policy is not None and exec_policy.repo_access is False:
        run_context = dict(run_context or {})
        run_context.setdefault("repo_access", False)
        log.info(
            "run_stage: repo_access=False — propagating short-circuit to mcp-server stage=%s role=%s",
            stage_key, agent_role,
        )

    # M74 Phase 2B — closed-loop wiring. When workgraph-api launches a
    # retry attempt after a prior failed eval gate, it threads structured
    # judge feedback into vars.eval_feedback. We render it as a system-
    # style user message at the head of history so the agent's first
    # turn sees "the previous attempt scored 2/5 because <reason>". Pattern
    # mirrors M74 Phase 1A's auto-verify injection — user role, not a
    # synthetic tool_call/tool_result pair (the LLM didn't emit anything;
    # faking provenance would lie to auditing).
    feedback_message = _render_eval_feedback_message((vars or {}).get("eval_feedback"))
    if feedback_message is not None:
        history.insert(0, feedback_message)

    result = StageRunResult(final_state=state)

    # M86 — preload StagePolicy once at the top of the loop so the
    # per-phase budget check (later in the iteration) has a real
    # StagePolicy in scope. policy_loader caches with TTL so this is a
    # no-op cost when run_turn fetches it again internally. None on
    # PolicyNotFoundError → budget falls back to _DEFAULT_MAX_TURNS_PER_PHASE.
    stage_policy: StagePolicy | None
    try:
        stage_policy = await load_stage_policy(stage_key, agent_role, bearer=bearer)
        # M91.A — apply workflow override so the M86 budget logic
        # operates on the EFFECTIVE policy (e.g. NONE strips all
        # phases of tools, so the budget can be relaxed).
        stage_policy = apply_execution_policy(stage_policy, exec_policy)
    except PolicyNotFoundError:
        stage_policy = None
    except StageExecutionPolicyError:
        # Fail-closed (review #5): a malformed override is a caller error,
        # not a defensive runtime hiccup. Don't swallow it to None (which
        # would skip filtering and run on the permissive base) — propagate
        # so the request fails loudly, same as the authoritative filter in
        # turn.py.
        raise
    except Exception as exc:  # pragma: no cover — defensive
        log.warning("stage_policy preload failed stage=%s role=%s err=%s", stage_key, agent_role, exc)
        stage_policy = None

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

    # Fix (review issue #3, 2026-05-23) — validation self-correction.
    #
    # Old behaviour: any validation_error returned VALIDATION_BLOCKED
    # on the FIRST occurrence, contradicting loop.py's documented
    # design ("the caller is expected to surface the structured
    # details to the LLM so it can fix the receipt and retry the
    # same phase"). A missing field in PlanReceipt aborted the whole
    # stage and required an external retry — typically the most
    # recoverable failure mode in the loop.
    #
    # New rule:
    #   • Allow up to _VALIDATION_RETRY_BUDGET CONSECUTIVE validation
    #     errors before aborting. Default 1 = one self-correction
    #     attempt, matching the reviewer's "at least one attempt"
    #     recommendation while preserving the safety property that
    #     a stuck LLM doesn't burn the full turn budget.
    #   • On a validation error we inject a user-role message into
    #     next-turn history carrying the structured error details so
    #     the LLM can actually see what to fix. Without this the
    #     loop would just keep failing the same way.
    #   • Counter resets on ANY successful step (phase advance or a
    #     non-validation turn) — a transient error doesn't poison
    #     a long-running session.
    # (2026-05-26) Bumped from 1 to 2 — observed agent iterating
    # productively across THREE shape errors (e.g. session 1267e003
    # design attempts bc84609f + e4454d7a: list_type → missing status
    # → uncertain-cascade). One retry wasn't enough to converge when
    # the receipt had multiple cosmetic issues. Two retries gives the
    # agent 3 total attempts at the same submit, which empirically
    # covers the common shape-iteration patterns without enabling
    # genuine infinite loops (still bounded by max_turns + the
    # stagnant-phase detector).
    _VALIDATION_RETRY_BUDGET = 2
    consecutive_validation_errors = 0

    # M96.2 — cumulative (non-consecutive) per-phase validation-error counter.
    #
    # The consecutive counter above resets on ANY non-validation step, which
    # is the right call for a transient shape error in an otherwise-healthy
    # session. But it has a blind spot: an agent that alternates
    # bad-receipt → tool-call → bad-receipt → tool-call never trips the
    # consecutive budget (each validation error is "isolated" by the
    # intervening tool call) yet makes no real progress toward a valid
    # receipt. Repro: develop attempt 3f8db8d7 spent 29 turns in ACT with
    # repeated EditReceipt validation failures interspersed with reads/edits,
    # never converging. The cumulative counter catches that pattern: once a
    # SINGLE phase has accumulated more than _VALIDATION_CUMULATIVE_BUDGET
    # validation errors (across the whole visit, consecutive or not), treat
    # it as blocked. Reset on phase advance (alongside phase_turn_counts) so a
    # legitimate re-entry gets a fresh budget.
    _VALIDATION_CUMULATIVE_BUDGET = 4
    validation_errors_in_phase: dict[str, int] = {}

    # M86 — per-phase turn budget. Tracks how many turns the model
    # has spent in each phase since the last advance. Reset when
    # the phase advances; we want the cap to apply per visit, not
    # globally (a stage that legitimately re-enters EXPLORE after
    # a send-back-style rewind gets a fresh budget).
    phase_turn_counts: dict[str, int] = {}
    phase_budget_warned: set[str] = set()  # phases where we've already
                                            # injected the mid-cap nudge,
                                            # to avoid spamming every turn.

    # M98 P3 — per-attempt code-context cache. Lives for exactly this
    # run_stage() call (one attempt) and is GC'd when it returns. run_turn()
    # builds the AST-indexed code_context_package on the first turn that
    # needs it and reuses the rendered markdown for the remaining turns
    # instead of re-indexing the repo every turn. See turn.py for the
    # cache shape + the GOVERNED_CODE_CONTEXT_CACHE opt-out.
    code_context_cache: dict[str, Any] = {}

    # M99 S1.1 — deterministic pre-ACT localization (Phase 1: SHADOW).
    # Runs ONCE per attempt, gated OFF by default. Extracted to a helper so
    # the gate + sweep + receipt-stash logic is unit-testable without driving
    # the full LLM turn loop. Shadow semantics: additive context only — never
    # blocks, never changes phase; any failure degrades silently.
    await _maybe_run_localization(
        state=state,
        vars=vars,
        run_context=run_context,
        bearer=bearer,
        exec_policy=exec_policy,
        stage_policy=stage_policy,
    )

    # M99 S1.3 / S2.1 (code-context E1) — git-preflight + auto-baseline now fire
    # at the REAL first-mutation boundary (first ACT entry) INSIDE the loop, not
    # here before PLAN. The old pre-loop placement ran them for stages that never
    # mutate and BEFORE the agent had planned; firing on ACT entry makes the
    # spec's "auto baseline before the first mutating tool" literally true while
    # keeping localization (above) at planning time where it belongs.
    _act_automation_done = False

    # P2 — a stage entered ALREADY at the approval gate has nothing to execute:
    # either a resume whose decision could not advance it (e.g. REPAIR cap
    # exhausted, so apply_approval_decision returned the state unchanged), or a
    # plain no-decision continuation of a paused stage. Re-surface APPROVAL_PENDING
    # immediately instead of spending an LLM turn that the post-turn gate (below)
    # would only halt on anyway. The normal first entry is PLAN, never SELF_REVIEW
    # with approval_pending, so this never short-circuits a fresh run.
    if state.approval_pending and state.current_phase is Phase.SELF_REVIEW:
        result.stop_reason = "APPROVAL_PENDING"
        return result

    _stage_started = time.monotonic()
    for turn_idx in range(max_turns):
        # Wall-clock safety deadline — bail cleanly BEFORE the HTTP client aborts
        # (see STAGE_WALL_CLOCK_SEC) so a slow stage returns a terminal result
        # rather than being orphaned server-side + duplicated by the client retry.
        if STAGE_WALL_CLOCK_SEC > 0 and not _is_terminal_state(state):
            _elapsed = time.monotonic() - _stage_started
            if _elapsed > STAGE_WALL_CLOCK_SEC:
                log.warning(
                    "governed stage wall-clock deadline hit: %.0fs > %ds (phase=%s turn=%d) — returning STAGE_DEADLINE",
                    _elapsed, int(STAGE_WALL_CLOCK_SEC), state.current_phase.value, turn_idx,
                )
                result.stop_reason = "STAGE_DEADLINE"
                result.final_state = state
                return result
        # E1 — fire once, the first time we enter ACT, before this iteration's
        # run_turn dispatches any mutating tool.
        if not _act_automation_done and state.current_phase is Phase.ACT:
            _act_automation_done = True
            await _maybe_run_git_preflight(
                state=state,
                vars=vars,
                run_context=run_context,
                bearer=bearer,
                exec_policy=exec_policy,
                stage_policy=stage_policy,
            )
            await _maybe_run_auto_baseline(
                state=state,
                run_context=run_context,
                bearer=bearer,
                exec_policy=exec_policy,
                stage_policy=stage_policy,
            )
        last_llm_error: LLMGatewayError | None = None
        needs_context_exc: MinContextUnavailable | None = None
        for llm_attempt in range(LLM_RETRY_ATTEMPTS + 1):
            try:
                turn = await run_turn(
                    state=state,
                    stage_key=stage_key,
                    agent_role=agent_role,
                    vars=vars,
                    history=history,
                    model_alias=model_alias,
                    phase_model_aliases=phase_model_aliases,
                    run_context=run_context,
                    bearer=bearer,
                    thinking_budget=thinking_budget,
                    exec_policy=exec_policy,
                    code_context_cache=code_context_cache,
                    governance_overlay=governance_overlay,
                    governance_waivers=governance_waivers,
                )
                last_llm_error = None
                break
            except MinContextUnavailable as exc:
                # Code-edit stage with no usable context → pause for a human.
                # Not retryable: re-asking won't materialize repo context.
                needs_context_exc = exc
                break
            except LLMGatewayError as exc:
                last_llm_error = exc
                if llm_attempt >= LLM_RETRY_ATTEMPTS or not _is_transient_llm_error(exc):
                    break
                delay = LLM_RETRY_BASE_DELAY_SEC * (2 ** llm_attempt)
                await emit_governed_event(
                    kind="governed.llm_retry",
                    state=state,
                    policy=None,
                    run_context=run_context,
                    payload={
                        "reason": exc.error_code,
                        "turn_idx": turn_idx,
                        "attempt": llm_attempt + 1,
                        "max_attempts": LLM_RETRY_ATTEMPTS + 1,
                        "delay_sec": delay,
                    },
                    severity="warn",
                )
                await asyncio.sleep(delay)
        else:  # pragma: no cover - loop always breaks or returns through error below.
            last_llm_error = LLMGatewayError("LLM_GATEWAY_UNAVAILABLE", "LLM retry loop exhausted")

        if last_llm_error is not None:
            result.stop_reason = "LLM_ERROR"
            result.error_code = last_llm_error.error_code
            result.error_message = str(last_llm_error)
            await emit_governed_event(
                kind="governed.stage_aborted",
                state=state,
                policy=None,
                run_context=run_context,
                payload={
                    "reason": last_llm_error.error_code,
                    "turn_idx": turn_idx,
                    "retry_attempts": LLM_RETRY_ATTEMPTS,
                },
                severity="warn",
            )
            return result

        # Minimum-context gate (code-context hardening D3) — a code-edit stage
        # built an empty context package. Halt as a human-resumable pause so the
        # agent never edits blind; the approval/inbox UI renders the reason.
        if needs_context_exc is not None:
            result.stop_reason = "NEEDS_CONTEXT"
            result.needs_context = needs_context_exc.to_dict()
            await emit_governed_event(
                kind="governed.stage_paused_needs_context",
                state=state,
                policy=None,
                run_context=run_context,
                payload=needs_context_exc.to_dict(),
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
            # M99 S2.2 — persist the auto-verify result as a first-class
            # AutoVerificationReceipt (pre-M99 it lived only as the unpersisted
            # SyntheticVerifierResult rendered into the prompt). Gated by
            # automation_enabled(..., "verify") — OFF by default, so this is a
            # no-op until rollout; the auto-verify BEHAVIOR (M74 1A) is
            # unchanged either way. Stashed under a sentinel; never raises.
            if automation_enabled(exec_policy, "verify") and isinstance(synth, dict):
                try:
                    state.receipts[_AUTO_VERIFICATION_KEY] = [
                        _auto_verification_receipt_from_synth(synth)
                    ]
                except Exception as exc:  # pragma: no cover — defensive
                    log.warning("M99 auto-verification receipt persist failed (non-fatal): %s", exc)

        # M74 Phase 3A — sliding-window history compression. Without this
        # the message log grows linearly with turn count (25 turns × ~4
        # messages = 100 messages, ~100KB by stage end). Anthropic prompt
        # caching only covers stable prefix; every new turn invalidates
        # the cache suffix. compress_history keeps the last
        # history_recent_turns (default 8) verbatim and breadcrumbs older
        # turns to one user-role message each.
        history = compress_history(history, recent_turns=history_recent_turns)

        state = turn.next_state
        result.final_state = state

        # Halt conditions, in priority order.

        # M95 — Not-actionable / no-op terminal. When PLAN declared
        # actionable != "yes", the loop short-circuited (loop.py) and set
        # step.not_actionable. Halt the stage NOW with a distinct reason so
        # the caller (workgraph-api) routes it to the human-confirmation
        # gate as "Story not actionable" rather than a normal approval or a
        # validation failure. Highest priority — it supersedes everything.
        if turn.step.not_actionable:
            result.not_actionable = turn.step.not_actionable
            result.stop_reason = "NOT_ACTIONABLE"
            return result

        # [#20] approvalRequired tool requested with no active waiver — halt the
        # stage GOVERNANCE_BLOCKED so the governing body can grant a
        # TOOL_APPROVAL:<tool> waiver. On re-attempt the waiver is active, the gate
        # lets the tool through, and the run proceeds (run-after-approval flow).
        if turn.step.tool_approval_required:
            _tar = turn.step.tool_approval_required
            result.governance_block = {
                "reason": "tool_approval_required",
                "tool_name": _tar.get("tool_name"),
                "controls": [_tar.get("control_key")],
                "allowedActions": ["request_waiver"],
            }
            result.stop_reason = "GOVERNANCE_BLOCKED"
            return result

        # Capability Governance Model (G4) — enforcement gate. At the moment the
        # stage would seek approval / finalize, a BLOCKING/REQUIRED governance
        # overlay must be satisfied (required evidence present / blocking controls
        # met) or waived; otherwise halt with GOVERNANCE_BLOCKED — a human-resumable
        # pause — instead of promoting. Fail-closed; ADVISORY overlays never block.
        if governance_overlay and (state.approval_pending or _is_terminal_state(state)):
            _blocked = _evaluate_governance_block(
                governance_overlay, _satisfied_evidence_keys(state), set(governance_waivers or []))
            if _blocked:
                result.governance_block = {
                    "controls": _blocked,
                    "allowedActions": ["SUBMIT_EVIDENCE", "RUN_VERIFIER", "REQUEST_WAIVER"],
                    "overlayHash": governance_overlay.get("overlayHash"),
                }
                result.stop_reason = "GOVERNANCE_BLOCKED"
                await emit_governed_event(
                    kind="governed.stage_blocked", state=state, policy=None,
                    run_context=run_context, payload=result.governance_block, severity="warn")
                return result

        if state.approval_pending and state.current_phase is Phase.SELF_REVIEW:
            result.stop_reason = "APPROVAL_PENDING"
            return result

        if _is_terminal_state(state):
            result.stop_reason = "FINALIZED"
            # [#25 write] Capture the run outcome as a long-term-memory candidate
            # (flag-gated CF_CAPTURE_RUN_MEMORY; best-effort, never blocks).
            await capture_run_outcome_memory(
                stage_key=stage_key, agent_role=agent_role, state=state,
                result=result, run_context=run_context, bearer=bearer,
            )
            return result

        if turn.step.validation_error and not turn.step.phase_advanced:
            consecutive_validation_errors += 1
            # M96.2 — cumulative per-phase counter (resets only on advance).
            _vphase = state.current_phase.value
            validation_errors_in_phase[_vphase] = (
                validation_errors_in_phase.get(_vphase, 0) + 1
            )
            cumulative_validation_errors = validation_errors_in_phase[_vphase]
            if (
                consecutive_validation_errors > _VALIDATION_RETRY_BUDGET
                or cumulative_validation_errors > _VALIDATION_CUMULATIVE_BUDGET
            ):
                # Retries exhausted (consecutive) OR the phase has churned
                # through too many validation errors overall (M96.2). Before
                # halting FAILED, try to salvage real edits the agent produced
                # but never packaged into a valid receipt (M96.1). The salvage
                # runs the real verifier and routes the outcome forward; if it
                # fires, stop_reason + final_state are already set.
                if await _salvage_mutating_phase(
                    result,
                    state,
                    stage_policy=stage_policy,
                    run_context=run_context,
                    bearer=bearer,
                    turn_idx=turn_idx,
                    trigger="validation_blocked",
                ):
                    return result
                # Nothing to salvage. Original safety property preserved:
                # surface to the caller rather than burn the entire turn
                # budget on a stuck LLM.
                result.stop_reason = "VALIDATION_BLOCKED"
                return result
            # Inject the structured validation error as a user-role
            # message so the LLM sees what was wrong on the next turn.
            # Without this the LLM has no feedback signal and would
            # almost certainly fail the same way.
            history.append(_render_validation_error_message(turn.step.validation_error))
            # Don't reset on this branch — we want consecutive errors
            # to accumulate. The other halt-condition resets below
            # only fire on success paths, so this counter naturally
            # zeroes when the next turn validates.
            continue
        else:
            # Reset the consecutive counter on any non-validation step. A
            # single bad receipt in the middle of an otherwise-healthy
            # session shouldn't be remembered forever. The CUMULATIVE
            # per-phase counter is NOT reset here — it only resets on a
            # phase advance (M96.2), so an alternating
            # bad-receipt → tool-call pattern still trips eventually.
            consecutive_validation_errors = 0

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
                # M96.1 — before declaring the phase stuck, salvage any real
                # edits the agent produced. A stuck mutating phase that already
                # mutated files is exactly the discard-correct-work case.
                if await _salvage_mutating_phase(
                    result,
                    state,
                    stage_policy=stage_policy,
                    run_context=run_context,
                    bearer=bearer,
                    turn_idx=turn_idx,
                    trigger="policy_blocked",
                ):
                    return result
                result.stop_reason = "POLICY_BLOCKED"
                return result

        if not turn.step.phase_advanced and not turn.step.validation_error:
            close_message = _render_architect_close_message(state)
            if close_message is not None:
                history.append(close_message)

        # (2026-05-26) Narrate-without-act bounce. The agent emitted text
        # in a mutating phase with no tool call and no submit_phase_output
        # — this is a failure mode the validation-error path doesn't see
        # (nothing was submitted to validate) and the stagnant guard only
        # catches after 3 turns. Hit it once: re-prompt immediately with
        # a clear correction so the next turn either calls a tool or
        # submits a receipt. Restricted to ACT / REPAIR because read-only
        # phases legitimately emit text-only responses sometimes.
        #
        # M83.y P3 (2026-05-27) — the original predicate missed the
        # "read-then-narrate" failure (model calls read_file in the
        # same turn it writes "Let me fix this:" without emitting the
        # follow-up apply_patch). _is_narrate_only_in_mutating_phase
        # catches both variants — empty turns AND read-only turns with
        # substantive prose — and tells us which message variant to
        # render. Repro from the field: develop attempt where the
        # agent diagnosed Map.of(null) NPEs ("Lines 136 and 167 use
        # Map.of() which rejects nulls. Let me fix this:") then
        # stopped without calling apply_patch.
        should_bounce, bounce_variant = _is_narrate_only_in_mutating_phase(state, turn)
        if should_bounce:
            log.info(
                "narrate-without-act bounce phase=%s variant=%s",
                state.current_phase.value,
                bounce_variant,
            )
            history.append(_render_narrate_without_act_message(state, bounce_variant))

        turns_remaining = max_turns - (turn_idx + 1)
        if (
            turns_remaining in {1, 2, 3}
            and not turn.step.phase_advanced
            and not turn.step.validation_error
            and not _is_terminal_state(state)
        ):
            history.append(_render_phase_deadline_message(state, turns_remaining))

        # M86 — per-phase turn budget. Increment the counter for the
        # phase the turn ENDED in (post-advance), reset on advance so a
        # legit "PLAN → EXPLORE → PLAN" rewind doesn't carry stale
        # counts. Then check the budget.
        if turn.step.phase_advanced:
            # Phase changed this turn — reset counts for the OLD phase
            # so a re-entry later gets a fresh budget, and start the
            # NEW phase at 1 (this turn counts toward it).
            phase_turn_counts[turn.step.from_phase] = 0
            phase_budget_warned.discard(turn.step.from_phase)
            # M96.2 — the cumulative validation-error counter is per-phase-visit;
            # clear the OLD phase so a legit re-entry (e.g. REPAIR→VERIFY→REPAIR)
            # gets a fresh budget rather than inheriting stale churn.
            validation_errors_in_phase[turn.step.from_phase] = 0
            cur_phase = state.current_phase.value
            phase_turn_counts[cur_phase] = 1
        else:
            cur_phase = state.current_phase.value
            phase_turn_counts[cur_phase] = phase_turn_counts.get(cur_phase, 0) + 1

        budget = _resolve_phase_budget(stage_policy, state.current_phase)
        turns_in_phase = phase_turn_counts.get(cur_phase, 0)
        if budget > 0 and turns_in_phase >= budget and not _is_terminal_state(state):
            # First time over: inject a forcing message so the next
            # turn is strongly biased toward submit_phase_output. The
            # message is idempotent — we only inject once per visit
            # so the agent isn't drowning in nudges.
            if cur_phase not in phase_budget_warned:
                phase_budget_warned.add(cur_phase)
                log.info(
                    "phase budget exceeded: phase=%s turns_in_phase=%d budget=%d",
                    cur_phase, turns_in_phase, budget,
                )
                history.append(_render_phase_budget_message(state, turns_in_phase, budget))
                await emit_governed_event(
                    kind="governed.phase_budget_exceeded",
                    state=state,
                    policy=stage_policy,
                    run_context=run_context,
                    payload={
                        "phase": cur_phase,
                        "turns_in_phase": turns_in_phase,
                        "budget": budget,
                    },
                    severity="warn",
                )
            # Hard halt at 2x budget — the model was warned and kept
            # spinning. Stop cleanly with a distinct stop_reason so the
            # operator sees PHASE_BUDGET_EXCEEDED rather than the
            # blanket MAX_TURNS.
            if turns_in_phase >= budget * 2:
                log.warning(
                    "phase budget halt: phase=%s turns=%d cap=%d",
                    cur_phase, turns_in_phase, budget * 2,
                )
                # M96.1 — salvage real edits before the hard budget halt.
                if await _salvage_mutating_phase(
                    result,
                    state,
                    stage_policy=stage_policy,
                    run_context=run_context,
                    bearer=bearer,
                    turn_idx=turn_idx,
                    trigger="phase_budget_exceeded",
                ):
                    return result
                result.stop_reason = "PHASE_BUDGET_EXCEEDED"
                return result

    if await _try_architect_self_review_fallback(result, state, run_context):
        return result

    # M96.1 — the loop ran out of turns. If the agent produced real edits in a
    # mutating phase but never packaged them, salvage rather than discard. The
    # architect read-only fallback above is mutually exclusive (read-only stages
    # never enter ACT/REPAIR), so the order is safe.
    if await _salvage_mutating_phase(
        result,
        state,
        stage_policy=stage_policy,
        run_context=run_context,
        bearer=bearer,
        turn_idx=turn_idx,
        trigger="max_turns",
    ):
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
