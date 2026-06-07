"""
M74 Phase 1A — auto-verification on mutation.

After the agent submits an EditReceipt, context-fabric synthesizes a
recommended_verification → run_test pair on the agent's behalf and
seeds the VERIFY phase's prompt context with the actual verifier
output. Restores invoke.ts:1903-2090's external-oracle pattern, which
the M71 governed-loop cutover dropped.

The motivation (from the architectural review):

  > The LLM is responsible for noticing that ACT changed code and
  > calling run_test. If the LLM skips VERIFY tool calls and submits
  > a VerificationReceipt with status: unavailable, the loop has no
  > way to disagree.

We disagree here by running the verifier ourselves and putting the
output in the LLM's next turn. The LLM still owns the VERIFY phase
output; it just can't pretend no verifier ran.

Failure handling is deliberately permissive: any failure of the
synthesis itself (registry unreachable, no runnable verifiers, etc.)
turns into an `auto_verify_unavailable` note rather than blocking the
stage. The agent is then free to call `verification_unavailable`
with the same reason — but it has to do so explicitly.

System-initiated tool calls bypass the policy gateway. Rationale:
the policy gateway exists to refuse LLM choices that violate stage
intent. The auto-verifier IS the stage intent (the policy is "you
must verify after edit"). Audit events still fire so operators see
it happened.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .dispatch import ToolDispatchError, dispatch_tool
from .grant import mint_tool_grant
from .phase_state import Phase
from .policy_loader import StagePolicy

log = logging.getLogger(__name__)


@dataclass
class SyntheticVerifierResult:
    """Outcome of one auto-verifier attempt. Always populated; the
    `kind` field tells the caller what to render to the LLM.

    Variants:

      kind="ran"        — verifier picked + dispatched + returned a
                          result. `command`, `args`, `exit_code`,
                          `stdout`, `stderr` are filled. `tool_success`
                          indicates whether the verifier itself
                          succeeded (exit 0); CF dispatched fine
                          regardless.

      kind="skipped"    — recommended_verification returned no runnable
                          entries. `reason` describes why; agent should
                          call verification_unavailable with same.

      kind="unavailable"— synthesis itself failed (registry HTTP error,
                          run_test dispatch error). `reason` describes
                          which step failed. Agent is free to call
                          run_test manually if it knows a command.
    """
    kind: str  # "ran" | "skipped" | "unavailable"
    reason: str | None = None
    command: str | None = None
    args: list[str] | None = None
    exit_code: int | None = None
    duration_ms: int | None = None
    stdout_summary: str | None = None
    stderr_summary: str | None = None
    tool_success: bool | None = None
    tool_invocation_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "reason": self.reason,
            "command": self.command,
            "args": self.args,
            "exit_code": self.exit_code,
            "duration_ms": self.duration_ms,
            "stdout_summary": self.stdout_summary,
            "stderr_summary": self.stderr_summary,
            "tool_success": self.tool_success,
            "tool_invocation_id": self.tool_invocation_id,
        }

    def to_history_message(self) -> dict[str, Any]:
        """Render as a system-injected user message that the next turn's
        LLM sees in its context. Deliberately NOT a synthetic tool_call
        with matching tool_result, because the LLM didn't emit the call
        — pretending it did would lie about provenance and confuse
        downstream auditing."""
        if self.kind == "ran":
            verdict = "PASSED" if self.tool_success else "FAILED"
            parts = [
                f"[AUTO-VERIFY] Automated verification ran on your edits: {verdict}.",
                f"Command: {self.command}",
            ]
            if self.exit_code is not None:
                parts.append(f"Exit code: {self.exit_code}")
            if self.stdout_summary:
                parts.append(f"stdout: {self.stdout_summary[:1500]}")
            if self.stderr_summary:
                parts.append(f"stderr: {self.stderr_summary[:1500]}")
            parts.append(
                "Include this command in your VerificationReceipt.commands_run "
                "(don't re-run it; the result is above). If it FAILED, the next "
                "phase should be REPAIR, not SELF_REVIEW."
            )
            return {"role": "user", "content": "\n".join(parts)}
        if self.kind == "skipped":
            return {
                "role": "user",
                "content": (
                    f"[AUTO-VERIFY] No runnable verifier was available "
                    f"({self.reason}). Call verification_unavailable with the "
                    "same reason, or run_test if you know an applicable command."
                ),
            }
        # unavailable
        return {
            "role": "user",
            "content": (
                f"[AUTO-VERIFY] Verification synthesis failed: {self.reason}. "
                "You may need to call run_test yourself; the orchestrator "
                "could not pick a command."
            ),
        }


def _changed_paths_from_edit_receipt(edit_receipt: dict[str, Any]) -> list[str]:
    """Pull file paths out of EditReceipt.edits[] for verifier ranking."""
    out: list[str] = []
    edits = edit_receipt.get("edits") or []
    for entry in edits:
        if not isinstance(entry, dict):
            continue
        path = entry.get("file")
        if isinstance(path, str) and path.strip():
            out.append(path.strip())
    return out


def first_runnable(recommended: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the highest-ranked (already sorted) recommendation that the
    MCP allowlist will actually execute."""
    for entry in recommended:
        if isinstance(entry, dict) and entry.get("runnable"):
            return entry
    return None


def _summarise(text: Any, *, max_len: int = 1500) -> str:
    """Coerce + truncate verifier output for the LLM prompt.

    Fix (review issue #2, 2026-05-23) — we used to truncate from the
    end (keep head). That blinded the LLM to pytest/jest tracebacks
    and AssertionError details because every test framework prints
    setup logs first and the actual failure last. The LLM saw "the
    run failed" but never saw WHY, so self-repair couldn't engage.
    Now we keep the TAIL and drop the head — tracebacks land near
    the end of the buffer and that's what the LLM needs to read.
    """
    if text is None:
        return ""
    s = str(text)
    if len(s) <= max_len:
        return s
    dropped = len(s) - max_len
    return f"...[truncated {dropped} earlier chars]\n" + s[-max_len:]


async def synthesize_verifier_run(
    edit_receipt: dict[str, Any],
    *,
    work_item_id: str | None,
    workspace_id: str | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
    policy: StagePolicy | None = None,
    phase: Phase | None = None,
) -> SyntheticVerifierResult:
    """Run recommended_verification → first runnable → run_test in sequence.

    Never raises. Every failure path returns a SyntheticVerifierResult
    with kind in {"skipped", "unavailable"} so the orchestrator can
    keep flowing into VERIFY with a clear note rather than aborting
    the stage.
    """
    changed = _changed_paths_from_edit_receipt(edit_receipt)

    # ── 1. Ask mcp-server for the ranked verifier list ────────────────
    try:
        rec_args = {"changed_paths": changed} if changed else {}
        rec_outcome = await dispatch_tool(
            "recommended_verification",
            rec_args,
            work_item_id=work_item_id,
            workspace_id=workspace_id,
            run_context=run_context,
            bearer=bearer,
            grant=mint_tool_grant(
                policy=policy,
                phase=phase,
                tool_name="recommended_verification",
                args=rec_args,
                run_context=run_context,
            ),
        )
    except ToolDispatchError as exc:
        log.warning("auto-verify: recommended_verification dispatch failed: %s", exc)
        return SyntheticVerifierResult(
            kind="unavailable",
            reason=f"recommended_verification dispatch failed: {exc!s}",
        )

    if not rec_outcome.tool_success:
        return SyntheticVerifierResult(
            kind="unavailable",
            reason=f"recommended_verification reported failure: {rec_outcome.tool_error or '(no detail)'}",
        )

    recommended = (
        (rec_outcome.result or {}).get("recommended") or []
        if isinstance(rec_outcome.result, dict)
        else []
    )
    pick = first_runnable(recommended)
    if pick is None:
        none_msg = (
            (rec_outcome.result or {}).get("guidance")
            if isinstance(rec_outcome.result, dict)
            else None
        ) or "no runnable verifier in registry for changed paths"
        return SyntheticVerifierResult(kind="skipped", reason=none_msg)

    # ── 2. Dispatch the picked run_test command ───────────────────────
    run_args: dict[str, Any] = {"command": pick.get("command")}
    if pick.get("args"):
        run_args["args"] = pick.get("args")

    try:
        run_outcome = await dispatch_tool(
            "run_test",
            run_args,
            work_item_id=work_item_id,
            workspace_id=workspace_id,
            run_context=run_context,
            bearer=bearer,
            grant=mint_tool_grant(
                policy=policy,
                phase=phase,
                tool_name="run_test",
                args=run_args,
                run_context=run_context,
            ),
        )
    except ToolDispatchError as exc:
        log.warning("auto-verify: run_test dispatch failed: %s", exc)
        return SyntheticVerifierResult(
            kind="unavailable",
            reason=f"run_test dispatch failed: {exc!s}",
            command=pick.get("command"),
            args=pick.get("args"),
        )

    result_data = run_outcome.result if isinstance(run_outcome.result, dict) else {}
    return SyntheticVerifierResult(
        kind="ran",
        command=pick.get("command"),
        args=pick.get("args"),
        exit_code=result_data.get("exit_code") if isinstance(result_data.get("exit_code"), int) else None,
        duration_ms=run_outcome.duration_ms,
        stdout_summary=_summarise(result_data.get("stdout") or result_data.get("stdout_summary")),
        stderr_summary=_summarise(result_data.get("stderr") or result_data.get("stderr_summary")),
        tool_success=run_outcome.tool_success,
        tool_invocation_id=run_outcome.tool_invocation_id,
    )
