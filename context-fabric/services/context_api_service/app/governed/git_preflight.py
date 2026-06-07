"""
M99 S1.3 — git push preflight (CF side).

The spec wants push viability classified BEFORE the workflow's push stage,
so auth/branch problems surface with a precise code + fix commands instead of
a generic post-failure reject. mcp-server exposes the `git_push_preflight`
tool (M99 S1.2) which runs `git push --dry-run` and maps any failure to a
discrete blocked_code; this module dispatches that tool on the platform's
behalf and shapes the result into a GitPreflightReceipt.

Same contract as verify_synthesis / localization:
  * NEVER raises — a dispatch failure degrades to an ok=False receipt with a
    reason rather than aborting the stage.
  * Gated by governed_automation.automation_enabled(policy, "preflight") at
    the call site (OFF by default in Phase 0).
  * Shadow mode (Phase 1): the receipt is recorded + injected for visibility;
    it does NOT block the stage. A later rollout phase can make
    gitPreflightRequired hard-gate the push.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .dispatch import ToolDispatchError, dispatch_tool
from .grant import mint_tool_grant
from .phase_state import Phase
from .policy_loader import StagePolicy

log = logging.getLogger(__name__)


@dataclass
class GitPreflightResult:
    """Outcome of the preflight dispatch. Always populated."""

    ok: bool = False
    remote: str | None = None
    branch: str | None = None
    blocked_code: str | None = None
    fix_commands: list[str] = field(default_factory=list)
    retryable: bool | None = None
    has_commit: bool | None = None
    message: str | None = None
    reason: str | None = None  # set when the preflight itself couldn't run

    def to_receipt_payload(self) -> dict[str, Any]:
        """Shape matching GitPreflightReceipt fields (sans kind/created_at)."""
        return {
            "ok": self.ok,
            "remote": self.remote,
            "branch": self.branch,
            "blocked_code": self.blocked_code,
            "fix_commands": self.fix_commands,
            "retryable": self.retryable,
            "has_commit": self.has_commit,
            "message": self.message,
            "origin": "platform",
        }


async def synthesize_git_preflight(
    *,
    branch: str | None,
    remote: str | None = None,
    work_item_id: str | None,
    workspace_id: str | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
    policy: StagePolicy | None = None,
    phase: Phase | None = None,
) -> GitPreflightResult:
    """Dispatch the git_push_preflight tool and shape its result. Never raises."""
    args: dict[str, Any] = {}
    if branch:
        args["branch"] = branch
    if remote:
        args["remote"] = remote

    try:
        outcome = await dispatch_tool(
            "git_push_preflight",
            args,
            work_item_id=work_item_id,
            workspace_id=workspace_id,
            run_context=run_context,
            bearer=bearer,
            grant=mint_tool_grant(
                policy=policy,
                phase=phase,
                tool_name="git_push_preflight",
                args=args,
                run_context=run_context,
            ),
        )
    except ToolDispatchError as exc:
        log.info("git preflight dispatch failed (non-fatal): %s", exc)
        return GitPreflightResult(
            ok=False,
            remote=remote,
            branch=branch,
            reason=f"git_push_preflight dispatch failed: {exc!s}",
        )

    if not outcome.tool_success:
        return GitPreflightResult(
            ok=False,
            remote=remote,
            branch=branch,
            reason=f"git_push_preflight reported failure: {outcome.tool_error or '(no detail)'}",
        )

    data = outcome.result if isinstance(outcome.result, dict) else {}
    fix = data.get("fix_commands")
    return GitPreflightResult(
        ok=bool(data.get("ok")),
        remote=data.get("remote") or remote,
        branch=data.get("branch") or branch,
        blocked_code=data.get("blocked_code"),
        fix_commands=[str(x) for x in fix] if isinstance(fix, list) else [],
        retryable=data.get("retryable") if isinstance(data.get("retryable"), bool) else None,
        has_commit=data.get("has_commit") if isinstance(data.get("has_commit"), bool) else None,
        message=data.get("message"),
    )
