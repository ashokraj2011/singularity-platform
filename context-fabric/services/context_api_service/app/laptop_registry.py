"""
M26 — in-memory registry of connected laptop mcp-server instances.

Holds (user_id, device_id) → ActiveConnection. Routes invokes from
execute.py to the right WebSocket. Open futures keyed by request_id wait
for the matching response frame.

Stateless across process restarts (R4) — laptops auto-reconnect.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import uuid4

from fastapi import WebSocket

log = logging.getLogger("laptop-registry")

INVOKE_TIMEOUT_SEC = 180
HEARTBEAT_TIMEOUT_SEC = 90
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024   # I2


@dataclass
class ActiveConnection:
    user_id:       str
    device_id:     str
    device_name:   str
    ws:            WebSocket
    connected_at:  float
    last_seen_at:  float
    pending:       dict[str, asyncio.Future] = field(default_factory=dict)
    # Frame types the laptop advertised in its `hello` (e.g. ["invoke",
    # "tool-run", "model-run"]). Used to route model-run frames only to
    # laptops that can serve LLM. Defaults to the legacy ["invoke"].
    supported_frame_types: list[str] = field(default_factory=lambda: ["invoke"])


class LaptopRegistry:
    def __init__(self) -> None:
        self._by_user:   dict[str, dict[str, ActiveConnection]] = {}   # user_id → device_id → conn
        self._lock = asyncio.Lock()

    # ── connection lifecycle ───────────────────────────────────────────────
    async def register(self, conn: ActiveConnection) -> None:
        """R2 — single connection per (user_id, device_id). Close the previous
        one if a fresh one arrives."""
        async with self._lock:
            by_device = self._by_user.setdefault(conn.user_id, {})
            existing = by_device.get(conn.device_id)
            if existing is not None and existing.ws is not conn.ws:
                log.info(
                    "laptop replacing prior connection user=%s device=%s",
                    conn.user_id, conn.device_id,
                )
                try:
                    await existing.ws.close(code=1000, reason="replaced")
                except Exception:
                    pass
            by_device[conn.device_id] = conn

    async def deregister(self, user_id: str, device_id: str) -> None:
        async with self._lock:
            by_device = self._by_user.get(user_id)
            if not by_device:
                return
            by_device.pop(device_id, None)
            if not by_device:
                self._by_user.pop(user_id, None)

    async def heartbeat(self, user_id: str, device_id: str) -> None:
        async with self._lock:
            conn = self._lookup(user_id, device_id)
            if conn:
                conn.last_seen_at = time.time()

    def _lookup(self, user_id: str, device_id: str) -> Optional[ActiveConnection]:
        return self._by_user.get(user_id, {}).get(device_id)

    async def any_for_user(self, user_id: str) -> Optional[ActiveConnection]:
        """Pick any live connection for this user (last-write-wins for v0)."""
        async with self._lock:
            by_device = self._by_user.get(user_id) or {}
            for conn in by_device.values():
                return conn
            return None

    async def any_for_user_serving(self, user_id: str, frame_type: str) -> Optional[ActiveConnection]:
        """Pick a live connection for this user that advertised ``frame_type`` in
        its hello.supported_frame_types. Used so model-run frames only go to a
        laptop that can serve LLM (avoids sending LLM work to a tools-only
        laptop). Returns None when none qualify → caller falls back to cloud."""
        async with self._lock:
            by_device = self._by_user.get(user_id) or {}
            for conn in by_device.values():
                if frame_type in (conn.supported_frame_types or []):
                    return conn
            return None

    # ── invoke routing ─────────────────────────────────────────────────────
    async def invoke(self, user_id: str, payload: dict[str, Any], timeout: float = INVOKE_TIMEOUT_SEC) -> dict[str, Any]:
        """Forward an /mcp/invoke payload to the user's laptop. Returns the
        response body. Raises LaptopNotConnected if no live connection.

        Legacy frame type — carries the full agent-loop payload that the
        laptop's executeInvokePayload() runs locally. M75 introduces
        ``dispatch_tool_via_laptop()`` (below) for per-tool dispatch
        under the governed loop; this method stays for backward compat
        with laptops on the old protocol.
        """
        # _send_frame_await_response returns (payload, conn) since
        # M75 Slice 5 so per-tool dispatch can surface device info; the
        # legacy invoke caller (execute.py) gets device meta via the
        # separate `resolve_laptop_target` lookup, so we discard the
        # conn here for back-compat.
        payload_out, _conn = await self._send_frame_await_response(
            user_id=user_id,
            frame_type="invoke",
            payload=payload,
            timeout=timeout,
            request_label="invoke",
        )
        return payload_out

    # ── M75 Slice 3 — per-tool dispatch over the bridge ───────────────────
    async def dispatch_tool_via_laptop(
        self,
        *,
        user_id: str,
        tool_name: str,
        args: dict[str, Any],
        run_context: dict[str, Any] | None = None,
        work_item_id: str | None = None,
        workspace_id: str | None = None,
        grant: dict[str, Any] | None = None,
        timeout: float = INVOKE_TIMEOUT_SEC,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        """Send a single tool-run frame to the user's laptop and await
        the response. Returns ``(payload, device_meta)`` where:

          payload    — matches the ToolRunResponsePayload zod schema:
                        { "result": ..., "duration_ms": int,
                          "tool_invocation_id": str, "tool_success": bool,
                          "tool_error": str | None }
          device_meta — { "device_id": str, "device_name": str } from
                        the ActiveConnection that handled the frame.
                        M75 Slice 5 — the audit emit in
                        governed.loop.governed_step uses this to write
                        `governed.tool_dispatched_via_laptop` with the
                        specific device so per-tool laptop badges work
                        the same way the legacy per-invoke badge did.

        Raises LaptopNotConnected when no laptop is online,
        LaptopSendFailed on WebSocket write errors, LaptopInvokeTimeout
        when the laptop doesn't respond within ``timeout``, and
        LaptopInvokeError when the laptop dispatches the tool but the
        runner itself failed (e.g. TOOL_RUN_FAILED).

        The payload shape matches mcp-server's HTTP /mcp/tool-run
        response so callers (``governed.dispatch.dispatch_tool``) can
        normalise both transports to one ToolDispatchResult dataclass.
        """
        payload: dict[str, Any] = {
            "tool_name": tool_name,
            "args": args or {},
            "run_context": run_context or {},
        }
        if work_item_id is not None:
            payload["work_item_id"] = work_item_id
        if workspace_id is not None:
            payload["workspace_id"] = workspace_id
        if grant is not None:
            payload["tool_grant"] = grant
        body, conn = await self._send_frame_await_response(
            user_id=user_id,
            frame_type="tool-run",
            payload=payload,
            timeout=timeout,
            request_label=f"tool-run({tool_name})",
        )
        return body, {"device_id": conn.device_id, "device_name": conn.device_name}

    # ── LLM dispatch over the bridge (full-BYO-laptop placement) ───────────
    async def dispatch_model_via_laptop(
        self,
        *,
        user_id: str,
        request_body: dict[str, Any],
        timeout: float = INVOKE_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Send a chat-completion request to the user's laptop over a
        ``model-run`` frame and await the gateway-shaped response. The laptop
        forwards ``request_body`` to its LOCAL llm-gateway
        (POST /v1/chat/completions) and returns the JSON unchanged.

        ``request_body`` is the same body context-fabric would POST to the cloud
        gateway (messages, tools, model_alias, …); the returned dict matches the
        gateway's /v1/chat/completions response, so callers parse it with
        ``ChatResponse.from_dict`` — identical shape to the cloud path.

        Raises LaptopNotConnected when no laptop advertising ``model-run`` is
        online (caller falls back to the cloud gateway), and the usual
        LaptopSendFailed / LaptopInvokeTimeout / LaptopInvokeError on transport
        or runner errors.
        """
        body, _conn = await self._send_frame_await_response(
            user_id=user_id,
            frame_type="model-run",
            payload=request_body,
            timeout=timeout,
            request_label="model-run",
            require_frame_type="model-run",
        )
        return body

    # ── code-context build over the bridge (laptop world model) ────────────
    async def dispatch_code_context_via_laptop(
        self,
        *,
        user_id: str,
        request_body: dict[str, Any],
        timeout: float = INVOKE_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Send a code-context build request to the user's laptop over a
        ``code-context`` frame and await the response. The laptop runs
        ``buildCodeContextPackage`` against its LOCAL per-workitem worktree and
        returns the SAME ``{success, data}`` envelope mcp-server's HTTP
        ``/mcp/code-context/build`` route returns — so the caller
        (``governed.code_context``) parses both transports identically.

        ``request_body`` is the same body context-fabric would POST to the
        cloud mcp-server (task_text, max_token_budget, run_context, …).

        Raises LaptopNotConnected when no laptop advertising ``code-context``
        is online (caller falls back to the static MCP_SERVER_URL HTTP path),
        and the usual LaptopSendFailed / LaptopInvokeTimeout / LaptopInvokeError
        on transport or runner errors.
        """
        body, _conn = await self._send_frame_await_response(
            user_id=user_id,
            frame_type="code-context",
            payload=request_body,
            timeout=timeout,
            request_label="code-context",
            require_frame_type="code-context",
        )
        return body

    async def _send_frame_await_response(
        self,
        *,
        user_id: str,
        frame_type: str,
        payload: dict[str, Any],
        timeout: float,
        request_label: str,
        require_frame_type: str | None = None,
    ) -> tuple[dict[str, Any], ActiveConnection]:
        """Common request/response plumbing shared by ``invoke`` and
        ``dispatch_tool_via_laptop``. Extracted so the per-frame logic
        stays a one-liner and the lifecycle (lookup → register pending
        future → send → wait → cleanup) is in one place.

        Returns ``(payload, conn)``. The conn is returned so callers
        that need per-device audit (M75 Slice 5) can read device_id /
        device_name without doing a second `any_for_user` lookup
        (which could race with reap_stale and pick a different
        connection). The legacy `invoke` caller discards it."""
        if require_frame_type:
            conn = await self.any_for_user_serving(user_id, require_frame_type)
            if conn is None:
                raise LaptopNotConnected(
                    f"no live laptop serving '{require_frame_type}' for user {user_id}"
                )
        else:
            conn = await self.any_for_user(user_id)
            if conn is None:
                raise LaptopNotConnected(f"no live laptop mcp-server for user {user_id}")

        request_id = uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        conn.pending[request_id] = fut

        frame = {"type": frame_type, "request_id": request_id, "payload": payload}
        try:
            await conn.ws.send_text(_dump_json(frame))
        except Exception as err:
            conn.pending.pop(request_id, None)
            raise LaptopSendFailed(str(err)) from err

        try:
            response = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            conn.pending.pop(request_id, None)
            raise LaptopInvokeTimeout(
                f"{request_label} {request_id} timed out after {timeout}s"
            )
        return response, conn

    async def deliver_response(self, user_id: str, device_id: str, request_id: str,
                               payload: Any, error: Optional[dict]) -> None:
        async with self._lock:
            conn = self._lookup(user_id, device_id)
        if conn is None:
            log.warning("response for unknown conn user=%s device=%s req=%s", user_id, device_id, request_id)
            return
        fut = conn.pending.pop(request_id, None)
        if fut is None or fut.done():
            return
        if error:
            fut.set_exception(LaptopInvokeError(
                code=str(error.get("code", "UNKNOWN")),
                message=str(error.get("message", "invocation error")),
                details=error.get("details"),
            ))
        else:
            fut.set_result(payload)

    # ── housekeeping ───────────────────────────────────────────────────────
    async def reap_stale(self) -> None:
        """R3 — drop connections whose last_seen_at is older than 90s."""
        cutoff = time.time() - HEARTBEAT_TIMEOUT_SEC
        async with self._lock:
            victims: list[tuple[str, str]] = []
            for user_id, by_device in self._by_user.items():
                for device_id, conn in by_device.items():
                    if conn.last_seen_at < cutoff:
                        victims.append((user_id, device_id))
            for user_id, device_id in victims:
                conn = self._by_user[user_id].pop(device_id, None)
                if conn:
                    log.info("reaping stale conn user=%s device=%s", user_id, device_id)
                    try:
                        await conn.ws.close(code=1000, reason="stale heartbeat")
                    except Exception:
                        pass


# ── exceptions ─────────────────────────────────────────────────────────────
class LaptopNotConnected(Exception):
    """Raised when /execute requires a laptop and none is connected."""


class LaptopSendFailed(Exception):
    """Raised when the WebSocket send to the laptop fails."""


class LaptopInvokeTimeout(Exception):
    """Raised when the laptop doesn't reply within the timeout."""


class LaptopInvokeError(Exception):
    """Raised when the laptop reports an explicit error."""
    def __init__(self, *, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


# ── singleton ──────────────────────────────────────────────────────────────
REGISTRY = LaptopRegistry()


def _dump_json(obj: Any) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False, default=str)
