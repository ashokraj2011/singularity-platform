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
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

log = logging.getLogger(__name__)


# Environment knobs match mcp-server's compose env.
#   MCP_SERVER_URL          — compose-internal URL (defaults to demo)
#   MCP_BEARER_TOKEN        — bearer the gateway authenticates against
#   MCP_TOOL_RUN_TIMEOUT_SEC — per-call timeout, default 120s
#   MCP_TOOL_RUN_LONG_TIMEOUT_SEC — timeout for slow agentic tools, default 960s
_MCP_URL = os.environ.get("MCP_SERVER_URL", "http://mcp-server:7100").rstrip("/")
_MCP_BEARER = os.environ.get("MCP_BEARER_TOKEN", "")
_TIMEOUT = float(os.environ.get("MCP_TOOL_RUN_TIMEOUT_SEC", "120"))
# Some tools run a whole agentic phase on the far side and legitimately take
# minutes — copilot_execute shells out to `copilot -p --allow-all` (its own
# timeout is 900s). The default 120s dispatch timeout aborts those mid-run with
# an (empty-string) httpx timeout surfaced as "mcp-server unreachable". Give the
# long-running set a much larger ceiling, just above the tool's own 900s.
_LONG_TIMEOUT = float(os.environ.get("MCP_TOOL_RUN_LONG_TIMEOUT_SEC", "960"))
_LONG_RUNNING_TOOLS = {"copilot_execute"}


def _timeout_for(tool_name: str) -> float:
    return _LONG_TIMEOUT if tool_name in _LONG_RUNNING_TOOLS else _TIMEOUT


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

    M75 Slice 5 adds the transport-provenance fields so the governed
    loop's audit emit can write `governed.tool_dispatched_via_laptop`
    with the specific device when the bridge handled the call. The
    HTTP path leaves device fields None; readers should check
    `served_by` before keying on them.
    """

    result: Any
    duration_ms: int
    tool_invocation_id: str
    tool_success: bool
    tool_error: str | None
    # M75 Slice 5 — provenance. "http" when the call went to the shared
    # mcp-server, "laptop" when the user's bridge handled it. Defaults
    # to "http" so older serialised callers (none today; defensive) keep
    # the same wire shape.
    served_by: Literal["http", "laptop"] = "http"
    laptop_device_id: str | None = None
    laptop_device_name: str | None = None


async def dispatch_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_id: str | None = None,
    work_item_id: str | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
    laptop_user_id: str | None = None,
    grant: dict[str, Any] | None = None,
) -> ToolDispatchResult:
    """Dispatch a single tool invocation. Default transport is HTTP
    POST to mcp-server's /mcp/tool-run; when ``laptop_user_id`` is set
    and the user has a live laptop-bridge connection, the call goes
    over the WebSocket to their laptop's mcp-server instead.

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
      bearer:        Override the env-default MCP_BEARER_TOKEN. Ignored on
                     the laptop path (the bridge handshake owns auth there).
      grant:         Optional signed ToolInvocationGrant (see governed.grant).
                     When present it's attached to the tool-run payload as
                     ``tool_grant`` so mcp-server can verify the call was
                     authorized by CF's governed loop before executing a
                     mutating / high-risk tool. ``None`` (the default, and what
                     ``mint_tool_grant`` returns when the feature is off) means
                     no grant is sent — the pre-hardening wire shape. HTTP and
                     laptop-bridge transports both carry the same grant field.
      laptop_user_id: M75 Slice 3 — when set, route via the laptop bridge
                     instead of HTTP. The caller (loop.py) populates this
                     from run_context.user_id when prefer_laptop is true
                     and the user has a live bridge connection.
                     Falls back to HTTP transparently if the laptop is
                     no longer connected by the time dispatch fires
                     (LaptopNotConnected → tries HTTP path).

    Raises:
      ToolDispatchError on endpoint failure (HTTP 4xx/5xx or bridge
      timeout / send failure / tool runner failure). Tool-level
      failures (handler returned success=false) come back inside
      ToolDispatchResult, not as throws.
    """
    # M75 Slice 6 — emergency rollback. LAPTOP_USE_LEGACY_INVOKE=true
    # forces every dispatch onto the shared HTTP mcp-server even if
    # the caller asked for laptop routing. Operators flip this when
    # the new per-tool bridge path has a production-level bug and the
    # safest move is to re-route all activity to the shared runner
    # while a fix ships. No re-deploy required — just restart the CF
    # container with the env set. Read at call time (not import time)
    # so a config reload via `docker compose up -d` picks it up
    # without rebuilding the image.
    legacy_flag = os.environ.get("LAPTOP_USE_LEGACY_INVOKE", "").strip().lower()
    legacy_active = legacy_flag in {"1", "true", "yes", "on"}
    if legacy_active and laptop_user_id:
        log.warning(
            "LAPTOP_USE_LEGACY_INVOKE active — forcing HTTP for tool=%s "
            "(would have routed to laptop user=%s)",
            tool_name,
            laptop_user_id,
        )
        laptop_user_id = None

    if laptop_user_id:
        try:
            return await _dispatch_via_laptop(
                user_id=laptop_user_id,
                tool_name=tool_name,
                args=args,
                workspace_id=workspace_id,
                work_item_id=work_item_id,
                run_context=run_context,
                grant=grant,
            )
        except _LaptopUnavailable as exc:
            # Bridge isn't actually connected at dispatch time — fall
            # through to the shared HTTP path rather than failing the
            # whole turn. The orchestrator-level "require laptop"
            # check is separate (see execute.py's prefer_laptop=True
            # branch that refuses 503 MCP_NOT_CONNECTED upstream of
            # this function).
            log.info(
                "laptop dispatch unavailable; falling back to HTTP tool=%s reason=%s",
                tool_name,
                exc,
            )

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
    if grant:
        # Defence-in-depth: signed proof that CF's governed loop authorized
        # THIS (tool, args, stage/phase/policy). mcp-server verifies it before
        # executing mutating / high-risk tools (see security/tool-grant.ts).
        payload["tool_grant"] = grant

    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
    }

    url = f"{_MCP_URL}/mcp/tool-run"
    try:
        async with httpx.AsyncClient(timeout=_timeout_for(tool_name)) as client:
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
        served_by="http",
    )


# ── M75 Slice 3 — laptop-bridge transport ────────────────────────────────


class _LaptopUnavailable(Exception):
    """Internal signal — laptop isn't connected at dispatch time, fall
    back to HTTP. Not raised to the caller (dispatch_tool catches and
    falls through to the HTTP path). Distinct from ToolDispatchError so
    the orchestrator doesn't conflate "no bridge" with "tool runner
    failed."""


async def _dispatch_via_laptop(
    *,
    user_id: str,
    tool_name: str,
    args: dict[str, Any],
    workspace_id: str | None,
    work_item_id: str | None,
    run_context: dict[str, Any] | None,
    grant: dict[str, Any] | None = None,
) -> ToolDispatchResult:
    """Bridge-side counterpart to the HTTP dispatch_tool body. Sends a
    tool-run frame via the laptop_registry and normalises the response
    payload into the same ToolDispatchResult shape the HTTP path
    returns.

    Three failure modes mapped explicitly:
      • LaptopNotConnected   → _LaptopUnavailable (caller falls back)
      • LaptopSendFailed     → ToolDispatchError("LAPTOP_SEND_FAILED")
      • LaptopInvokeTimeout  → ToolDispatchError("LAPTOP_TIMEOUT")
      • LaptopInvokeError    → ToolDispatchError(code from frame)

    The wire response shape comes from the laptop's runToolByName +
    relay-client.ts mapping (Slice 2). Snake_case here matches what
    that handler emits; the HTTP path uses camelCase for legacy
    reasons.
    """
    # Lazy import to avoid pulling the WebSocket stack into this module
    # at import time; matches the pattern in laptop_dispatcher.py.
    from ..laptop_registry import (
        REGISTRY,
        LaptopInvokeError,
        LaptopInvokeTimeout,
        LaptopNotConnected,
        LaptopSendFailed,
    )

    try:
        registry_response = await REGISTRY.dispatch_tool_via_laptop(
            user_id=user_id,
            tool_name=tool_name,
            args=args or {},
            run_context=run_context or {},
            work_item_id=work_item_id,
            workspace_id=workspace_id,
            grant=grant,
            timeout=_timeout_for(tool_name),
        )
    except LaptopNotConnected as exc:
        raise _LaptopUnavailable(str(exc)) from exc
    except LaptopSendFailed as exc:
        raise ToolDispatchError(f"LAPTOP_SEND_FAILED: {exc}") from exc
    except LaptopInvokeTimeout as exc:
        raise ToolDispatchError(f"LAPTOP_TIMEOUT: {exc}") from exc
    except LaptopInvokeError as exc:
        raise ToolDispatchError(f"{exc.code}: {exc.message}") from exc

    # M75 Slice 5 — laptop_registry.dispatch_tool_via_laptop now returns
    # (payload, device_meta). Older tests / call sites may still return
    # a bare dict (defensive: tolerate both shapes). When meta is
    # missing we keep served_by="laptop" but leave device fields None
    # so consumers can still detect bridge transport even without the
    # specific device name.
    if isinstance(registry_response, tuple) and len(registry_response) == 2:
        body, device_meta = registry_response
    else:
        body, device_meta = registry_response, {}

    if not isinstance(body, dict):
        raise ToolDispatchError(
            f"laptop tool-run response was not a dict: {body!r}"
        )

    device_id = device_meta.get("device_id") if isinstance(device_meta, dict) else None
    device_name = device_meta.get("device_name") if isinstance(device_meta, dict) else None

    # Field names: snake_case per ToolRunResponsePayload (zod schema
    # in mcp-server/src/laptop/envelopes.ts). HTTP path uses camelCase;
    # both flow into the same ToolDispatchResult shape.
    return ToolDispatchResult(
        result=body.get("result"),
        duration_ms=int(body.get("duration_ms", 0)),
        tool_invocation_id=str(body.get("tool_invocation_id", "")),
        tool_success=bool(body.get("tool_success", False)),
        tool_error=body.get("tool_error"),
        served_by="laptop",
        laptop_device_id=device_id,
        laptop_device_name=device_name,
    )
