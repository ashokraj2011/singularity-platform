"""
In-memory registry of connected MCP runtime bridge instances.

Historically this module was the "laptop bridge". V1 runtime dial-in keeps the
old names as compatibility aliases, but the registry now tracks generic MCP
runtimes keyed by user/tenant/runtime identity. Open futures keyed by
request_id wait for the matching response frame.

Stateless across process restarts (R4) — runtimes auto-reconnect.
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
    runtime_id:     str = ""
    runtime_type:   str = "mcp"
    tenant_id:      str = ""
    shared:         bool = False
    capability_tags: list[str] = field(default_factory=list)
    health:         dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.runtime_id:
            self.runtime_id = self.device_id
        if not self.device_id:
            self.device_id = self.runtime_id


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
                    "runtime replacing prior connection user=%s runtime=%s",
                    conn.user_id, conn.device_id,
                )
                try:
                    await existing.ws.close(code=1000, reason="replaced")
                except Exception:
                    pass
                # Finding #14 — fail the replaced connection's in-flight calls now.
                self._fail_pending(existing, "runtime replaced by a new connection")
            by_device[conn.device_id] = conn

    async def deregister(self, user_id: str, device_id: str, conn: Optional[ActiveConnection] = None) -> None:
        async with self._lock:
            by_device = self._by_user.get(user_id)
            if not by_device:
                return
            current = by_device.get(device_id)
            if current is None:
                return
            # Finding #13 — identity guard. A reconnect stores the NEW conn under the same
            # (user_id, device_id) key and closes the OLD socket; the old socket's handler
            # then runs its finally and calls deregister. Only remove the entry when it is
            # the SAME connection object, so the old handler can't evict the new connection
            # from routing (which would leave the runtime live but unreachable).
            if conn is not None and current is not conn:
                return
            by_device.pop(device_id, None)
            if not by_device:
                self._by_user.pop(user_id, None)
            # Finding #14 — fail this connection's in-flight calls immediately.
            self._fail_pending(current, "runtime disconnected")

    @staticmethod
    def _fail_pending(conn: Optional[ActiveConnection], reason: str) -> None:
        """Finding #14 — reject every pending invoke on a dying connection so callers get
        an immediate LaptopDisconnected instead of waiting out the full invoke timeout."""
        if conn is None:
            return
        pending, conn.pending = conn.pending, {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(LaptopDisconnected(reason))

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

    async def select_runtime(
        self,
        *,
        user_id: str | None,
        tenant_id: str | None = None,
        frame_type: str | None = None,
        capability_tags: list[str] | None = None,
    ) -> Optional[ActiveConnection]:
        """Select the runtime for a frame.

        Routing order:
          1. user-owned connected runtime for the run user
          2. tenant/shared connected runtime

        Capability tags narrow eligibility, but never override user/tenant
        placement. The method deliberately does not fall back to arbitrary
        runtimes from other users.
        """
        async with self._lock:
            if user_id:
                for conn in (self._by_user.get(user_id) or {}).values():
                    if self._matches(conn, frame_type, tenant_id, capability_tags):
                        return conn

            if tenant_id:
                for by_device in self._by_user.values():
                    for conn in by_device.values():
                        if not self._is_shared_runtime(conn):
                            continue
                        # Finding #15 — a shared runtime may serve a tenant-scoped request only
                        # when it carries that exact tenant; a tenantless shared runtime is not
                        # eligible for tenant work (the user-owned path above stays lenient so
                        # personal tenantless laptops still serve their owner's tenant work).
                        if conn.tenant_id != tenant_id:
                            continue
                        if self._matches(conn, frame_type, tenant_id, capability_tags):
                            return conn
            return None

    def _matches(
        self,
        conn: ActiveConnection,
        frame_type: str | None,
        tenant_id: str | None,
        capability_tags: list[str] | None,
    ) -> bool:
        # A request that carries a tenant must not be served by a connection bound to a
        # DIFFERENT tenant. A tenantless connection (conn.tenant_id == "") is allowed here so a
        # user's own personal laptop (kind=device tokens are tenantless) still serves their own
        # tenant-scoped work; the shared-runtime path (select_runtime) applies the stricter
        # exact match so a tenantless SHARED runtime can't pick up tenant work (finding #15).
        if tenant_id and conn.tenant_id and conn.tenant_id != tenant_id:
            return False
        if frame_type and frame_type not in (conn.supported_frame_types or []):
            return False
        requested = {str(tag) for tag in (capability_tags or []) if str(tag)}
        if requested:
            advertised = {str(tag) for tag in (conn.capability_tags or []) if str(tag)}
            if not requested.issubset(advertised):
                return False
        return True

    def _is_shared_runtime(self, conn: ActiveConnection) -> bool:
        marker_users = {"", "*", "shared", "__shared__"}
        return bool(conn.shared or conn.user_id in marker_users or conn.user_id == conn.tenant_id)

    async def status_snapshot(self) -> dict[str, Any]:
        async with self._lock:
            connected: list[dict[str, Any]] = []
            grouped: dict[str, dict[str, Any]] = {}
            for user_id, by_device in self._by_user.items():
                for device_id, conn in by_device.items():
                    row = {
                        "user_id": user_id,
                        "tenant_id": conn.tenant_id,
                        "runtime_id": conn.runtime_id or device_id,
                        "runtime_type": conn.runtime_type,
                        "device_id": device_id,
                        "device_name": conn.device_name,
                        "shared": conn.shared,
                        "supported_frame_types": list(conn.supported_frame_types or []),
                        "capability_tags": list(conn.capability_tags or []),
                        "health": conn.health or {},
                        "connected_at": conn.connected_at,
                        "last_seen_at": conn.last_seen_at,
                    }
                    connected.append(row)
                    tenant_key = conn.tenant_id or "unknown"
                    user_key = user_id or "__shared__"
                    type_key = conn.runtime_type or "unknown"
                    tenant_group = grouped.setdefault(tenant_key, {"users": {}, "runtimes": []})
                    user_group = tenant_group["users"].setdefault(user_key, {"runtime_types": {}, "runtimes": []})
                    type_group = user_group["runtime_types"].setdefault(type_key, [])
                    type_group.append(row)
                    user_group["runtimes"].append(row)
                    tenant_group["runtimes"].append(row)
            return {
                "status": "ok",
                "connected": connected,
                "count": len(connected),
                "tenants": grouped,
            }

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
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
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
            tenant_id=tenant_id,
            capability_tags=capability_tags,
            frame_type="tool-run",
            payload=payload,
            timeout=timeout,
            request_label=f"tool-run({tool_name})",
            require_frame_type="tool-run",
        )
        return body, {"device_id": conn.device_id, "device_name": conn.device_name}

    # ── LLM dispatch over the bridge (full-BYO-laptop placement) ───────────
    async def dispatch_model_via_laptop(
        self,
        *,
        user_id: str,
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
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
            tenant_id=tenant_id,
            capability_tags=capability_tags,
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
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
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
            tenant_id=tenant_id,
            capability_tags=capability_tags,
            frame_type="code-context",
            payload=request_body,
            timeout=timeout,
            request_label="code-context",
            require_frame_type="code-context",
        )
        return body

    async def dispatch_source_via_laptop(
        self,
        *,
        user_id: str,
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
        op: str,
        request_body: dict[str, Any],
        timeout: float = INVOKE_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Send a repo source-discovery request to the user's laptop over a
        ``source-tree`` / ``source-file`` frame and await the response. The laptop
        runs the GitHub fetch with its LOCAL GITHUB_TOKEN and returns the SAME
        ``{tree}`` / ``{content}`` payload mcp-server's HTTP ``/mcp/source/*``
        routes return — so a cloud control plane (agent-runtime capability
        bootstrap) can discover a repo through the user's laptop runtime instead
        of needing its own GitHub egress / a reachable mcp HTTP endpoint.

        ``op`` is "tree" or "file"; ``request_body`` is {repoUrl, branch[, path]}.
        Raises LaptopNotConnected when no laptop advertising the frame is online.
        """
        frame_type = f"source-{op}"
        body, _conn = await self._send_frame_await_response(
            user_id=user_id,
            tenant_id=tenant_id,
            capability_tags=capability_tags,
            frame_type=frame_type,
            payload=request_body,
            timeout=timeout,
            request_label=frame_type,
            require_frame_type=frame_type,
        )
        return body

    async def _send_frame_await_response(
        self,
        *,
        user_id: str,
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
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
        required = require_frame_type or frame_type
        conn = await self.select_runtime(
            user_id=user_id,
            tenant_id=tenant_id,
            frame_type=required,
            capability_tags=capability_tags,
        )
        if conn is None:
            scope = f"user {user_id}" if not tenant_id else f"user {user_id} tenant {tenant_id}"
            raise LaptopNotConnected(f"no live runtime serving '{required}' for {scope}")

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
                    # Finding #14 — fail in-flight calls instead of letting them wait out
                    # the full invoke timeout after the runtime has gone stale.
                    self._fail_pending(conn, "runtime stale (heartbeat timeout)")


# ── exceptions ─────────────────────────────────────────────────────────────
class LaptopNotConnected(Exception):
    """Raised when /execute requires a laptop and none is connected."""


class LaptopDisconnected(LaptopNotConnected):
    """Raised into a pending invoke when its runtime disconnects, is replaced, or is reaped,
    so the caller fails fast instead of waiting out the full timeout (finding #14).

    Subclasses LaptopNotConnected so the existing dispatch handlers (governed/dispatch.py,
    llm_client.py, code_context.py) treat a mid-call disconnect exactly like a never-connected
    runtime — fall back to HTTP/cloud — rather than letting it escape uncaught and crash the
    whole governed turn (review finding)."""


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
