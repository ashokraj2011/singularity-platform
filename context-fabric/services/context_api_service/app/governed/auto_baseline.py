"""
M99 S2.1 — platform-driven auto-baseline.

The spec asks the platform to capture a test baseline BEFORE the first
mutating tool, automatically, whenever runnable verification exists — so
post-edit verification can tell new regressions apart from inherited
failures without relying on the agent to remember to call
capture_test_baseline (the pre-M99 behavior, which was model-driven and
reactive — loop.py only stashed a baseline IF the agent chose to dispatch
the tool).

This module makes that platform-driven:
  1. ask mcp-server's recommended_verification for the runnable verifier
  2. dispatch capture_test_baseline with that command
  3. stash the failing-test set (reusing baseline_diff.stash_baseline, so
     the existing post-edit enrich_verification_receipt path picks it up
     unchanged) AND return a structured BaselineResult the caller persists
     as a BaselineReceipt.

Same contract as verify_synthesis / localization / git_preflight:
  * NEVER raises — every failure path returns a BaselineResult with
    captured=False + a reason.
  * Gated by governed_automation.automation_enabled(policy, "baseline")
    at the call site (OFF by default in Phase 0).
  * Idempotent at the stash layer (baseline_diff keeps the first baseline).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .baseline_diff import extract_failing_tests_from_tool_output, stash_baseline
from .dispatch import ToolDispatchError, dispatch_tool
from .verify_synthesis import _first_runnable

log = logging.getLogger(__name__)


@dataclass
class BaselineResult:
    """Outcome of one auto-baseline attempt. Always populated."""

    captured: bool = False
    tests_ran: bool = False
    failing_tests: list[str] = field(default_factory=list)
    commands_run: list[str] = field(default_factory=list)
    reason: str | None = None
    summary: str | None = None

    def to_receipt_payload(self) -> dict[str, Any]:
        """Shape matching BaselineReceipt fields (sans kind/created_at)."""
        return {
            "captured": self.captured,
            "tests_ran": self.tests_ran,
            "failing_tests": self.failing_tests,
            "commands_run": self.commands_run,
            "reason": self.reason,
            "summary": self.summary,
            "origin": "platform",
        }


async def synthesize_baseline(
    *,
    state_receipts: dict[str, list[dict[str, Any]]],
    work_item_id: str | None,
    workspace_id: str | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
) -> BaselineResult:
    """Capture a pre-mutation test baseline. Never raises.

    Writes the baseline into `state_receipts` (via stash_baseline) so the
    existing post-edit diff path works unchanged, and returns a
    BaselineResult for the caller to persist as a BaselineReceipt.
    """
    # ── 1. Ask for the ranked verifier list (no changed paths yet — this is
    #       the PRE-edit baseline, so we want the broad/default verifier). ──
    try:
        rec_outcome = await dispatch_tool(
            "recommended_verification",
            {},
            work_item_id=work_item_id,
            workspace_id=workspace_id,
            run_context=run_context,
            bearer=bearer,
        )
    except ToolDispatchError as exc:
        log.info("auto-baseline: recommended_verification dispatch failed: %s", exc)
        return BaselineResult(reason=f"recommended_verification dispatch failed: {exc!s}")

    if not rec_outcome.tool_success:
        return BaselineResult(
            reason=f"recommended_verification reported failure: {rec_outcome.tool_error or '(no detail)'}",
        )

    recommended = (
        (rec_outcome.result or {}).get("recommended") or []
        if isinstance(rec_outcome.result, dict)
        else []
    )
    pick = _first_runnable(recommended)
    if pick is None:
        guidance = (
            (rec_outcome.result or {}).get("guidance")
            if isinstance(rec_outcome.result, dict)
            else None
        ) or "no runnable verifier in registry — nothing to baseline"
        return BaselineResult(reason=guidance)

    command = pick.get("command")
    if not command:
        return BaselineResult(reason="recommended verifier had no command")

    # ── 2. Dispatch capture_test_baseline with the picked command. ──
    base_args: dict[str, Any] = {"command": command}
    if pick.get("args"):
        base_args["args"] = pick.get("args")

    try:
        outcome = await dispatch_tool(
            "capture_test_baseline",
            base_args,
            work_item_id=work_item_id,
            workspace_id=workspace_id,
            run_context=run_context,
            bearer=bearer,
        )
    except ToolDispatchError as exc:
        log.info("auto-baseline: capture_test_baseline dispatch failed: %s", exc)
        return BaselineResult(
            reason=f"capture_test_baseline dispatch failed: {exc!s}",
            commands_run=[str(command)],
        )

    if not outcome.tool_success:
        return BaselineResult(
            reason=f"capture_test_baseline reported failure: {outcome.tool_error or '(no detail)'}",
            commands_run=[str(command)],
        )

    # ── 3. Extract + stash (mirrors the reactive loop.py:650-674 path so the
    #       post-edit enrich_verification_receipt picks it up unchanged). ──
    failing, total = extract_failing_tests_from_tool_output(outcome.result)
    stash_baseline(state_receipts, failing, total, command=str(command))
    failing_sorted = sorted(failing)
    return BaselineResult(
        captured=True,
        tests_ran=True,
        failing_tests=failing_sorted,
        commands_run=[str(command)],
        summary=(
            f"baseline captured: {len(failing_sorted)} pre-existing failure(s)"
            + (f" of {total} test(s)" if isinstance(total, int) else "")
            + f" via `{command}`"
        ),
    )
