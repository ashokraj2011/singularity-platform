"""
M71 Slice C(a) — Tool dispatch client.

After context-fabric's `tool_gateway.check_tool_allowed()` clears a tool
call, this module is what actually fires the request at mcp-server's
`/mcp/tool-run` endpoint. mcp-server runs the tool inside its sandbox and
returns `{result, durationMs, toolSuccess, toolError?, toolInvocationId}`.

Why a separate module: the LLM loop wrapper (Slice C(b)) will want to mock
this in tests, and the standalone client is the right seam to swap. It
also keeps the orchestrator (`loop.py`) free of HTTP plumbing.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)


# Environment knobs match mcp-server's compose env.
#   MCP_SERVER_URL          — compose-internal URL (defaults to demo)
#   MCP_BEARER_TOKEN        — bearer the gateway authenticates against
#   MCP_TOOL_RUN_TIMEOUT_SEC — per-call timeout, default 120s
_MCP_URL = os.environ.get("MCP_SERVER_URL", "http://mcp-server-demo:7100").rstrip("/")
_MCP_BEARER = os.environ.get("MCP_BEARER_TOKEN", "")
_TIMEOUT = float(os.environ.get("MCP_TOOL_RUN_TIMEOUT_SEC", "120"))


class ToolDispatchError(RuntimeError):
    """Endpoint-level failure (network error / 5xx / 401). Distinct from
    tool-level failure (tool ran but returned success=false) — that lands
    in ToolDispatchResult.tool_success.
    """

    error_code = "TOOL_DISPATCH_FAILED"


@dataclass(frozen=True)
class ToolDispatchResult:
    """Decoded /mcp/tool-run response. Fields mirror the endpoint contract.

    `tool_success` distinguishes a clean tool-level failure (rerun, fix,
    move on) from `ToolDispatchError` (network/auth/server crash — retry
    transparently or surface to the caller).
    """

    result: Any
    duration_ms: int
    tool_invocation_id: str
    tool_success: bool
    tool_error: str | None


async def dispatch_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_id: str | None = None,
    work_item_id: str | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
) -> ToolDispatchResult:
    """POST a single tool invocation to mcp-server's /mcp/tool-run.

    The caller has ALREADY cleared the policy check via
    `tool_gateway.check_tool_allowed()`. This function does NOT re-verify
    permission — that's the gateway's job.

    Args:
      tool_name:     The local tool name as registered in mcp-server.
      args:          Tool arguments. mcp-server validates against the
                     tool's input schema.
      workspace_id:  Either workspace_id OR work_item_id should be set so
                     mcp-server can route to the right sandbox.
      work_item_id:  Same as workspace_id; mcp-server treats them as aliases.
      run_context:   Optional correlation: traceId, runId, workflowInstanceId,
                     nodeId, branchName, capabilityId, etc. Flows into the
                     audit invocation record.
      bearer:        Override the env-default MCP_BEARER_TOKEN — useful when
                     a per-call session token is preferred (e.g. workgraph-api
                     forwarding a user JWT scoped to the capability).

    Raises:
      ToolDispatchError on 4xx/5xx (with response body for triage).
    """
    if not _MCP_URL:
        raise ToolDispatchError("MCP_SERVER_URL is not configured in context-fabric")
    token = bearer or _MCP_BEARER
    if not token:
        raise ToolDispatchError("MCP_BEARER_TOKEN is not configured in context-fabric")

    payload: dict[str, Any] = {
        "tool_name": tool_name,
        "args": args,
    }
    if work_item_id:
        payload["work_item_id"] = work_item_id
    if workspace_id:
        payload["workspace_id"] = workspace_id
    if run_context:
        payload["run_context"] = run_context

    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
    }

    url = f"{_MCP_URL}/mcp/tool-run"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise ToolDispatchError(f"mcp-server unreachable: {exc}") from exc

    body: dict[str, Any]
    try:
        body = response.json()
    except ValueError:
        raise ToolDispatchError(
            f"mcp-server returned non-JSON ({response.status_code}): {response.text[:200]}"
        )

    if not response.is_success:
        # The endpoint's error shape is `{success: false, error: {code, message, details}}`.
        err = body.get("error") if isinstance(body, dict) else None
        code = (err or {}).get("code", f"HTTP_{response.status_code}")
        msg = (err or {}).get("message", body.get("message") if isinstance(body, dict) else "")
        log.warning(
            "tool dispatch failed status=%s code=%s tool=%s",
            response.status_code,
            code,
            tool_name,
        )
        raise ToolDispatchError(f"{code}: {msg}")

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise ToolDispatchError(f"mcp-server response missing `data` block: {body!r}")

    return ToolDispatchResult(
        result=data.get("result"),
        duration_ms=int(data.get("durationMs", 0)),
        tool_invocation_id=str(data.get("toolInvocationId", "")),
        tool_success=bool(data.get("toolSuccess", False)),
        tool_error=data.get("toolError"),
    )
