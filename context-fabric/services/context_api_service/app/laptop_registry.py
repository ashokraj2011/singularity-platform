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
_REDACTED = "[redacted]"
_SENSITIVE_KEY_PARTS = (
    "token",
    "secret",
    "password",
    "credential",
    "authorization",
    "bearer",
    "api_key",
    "apikey",
    "access_key",
    "private_key",
)


def _is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_").replace(" ", "_")
    return any(part in normalized for part in _SENSITIVE_KEY_PARTS)


def _sanitize_metadata(value: Any, *, depth: int = 0) -> Any:
    """Return operator-safe metadata for status/diagnostic surfaces.

    Runtime health is client-supplied. Keep useful readiness booleans/URLs, but
    redact secret-shaped keys and bound payload size so a runtime cannot leak
    tokens or flood Operations UI/debug endpoints through its hello frame.
    """
    if depth > 6:
        return "[truncated]"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 50:
                out["__truncated__"] = True
                break
            key_s = str(key)
            out[key_s] = _REDACTED if _is_sensitive_key(key_s) else _sanitize_metadata(item, depth=depth + 1)
        return out
    if isinstance(value, list):
        items = [_sanitize_metadata(item, depth=depth + 1) for item in value[:20]]
        if len(value) > 20:
            items.append("[truncated]")
        return items
    if isinstance(value, tuple):
        items = [_sanitize_metadata(item, depth=depth + 1) for item in value[:20]]
        if len(value) > 20:
            items.append("[truncated]")
        return items
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower().startswith(("bearer ", "token ")):
            return _REDACTED
        if len(stripped) > 500:
            return f"{stripped[:500]}...[truncated]"
        return value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)


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

    async def heartbeat(self, user_id: str, device_id: str, health: Optional[dict[str, Any]] = None) -> None:
        async with self._lock:
            conn = self._lookup(user_id, device_id)
            if conn:
                conn.last_seen_at = time.time()
                if isinstance(health, dict):
                    conn.health = health

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

    async def diagnostics(
        self,
        *,
        user_id: str | None = None,
        tenant_id: str | None = None,
        frame_type: str | None = None,
        capability_tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Explain runtime routing instead of forcing operators to infer it
        from /status and logs. This deliberately mirrors select_runtime's
        rules and returns candidate rejection reasons."""
        async with self._lock:
            requested_tags = {str(tag) for tag in (capability_tags or []) if str(tag)}
            candidates: list[dict[str, Any]] = []
            selected: dict[str, Any] | None = None

            for candidate_user_id, by_device in self._by_user.items():
                for device_id, conn in by_device.items():
                    reasons: list[str] = []
                    path = "other-user"
                    if user_id and candidate_user_id == user_id:
                        path = "user-owned"
                    elif tenant_id and self._is_shared_runtime(conn):
                        path = "tenant-shared"
                    elif user_id:
                        reasons.append("different-user")

                    if tenant_id and conn.tenant_id and conn.tenant_id != tenant_id:
                        reasons.append("different-tenant")
                    if tenant_id and path == "tenant-shared" and conn.tenant_id != tenant_id:
                        reasons.append("shared-runtime-not-bound-to-tenant")
                    if frame_type and frame_type not in (conn.supported_frame_types or []):
                        reasons.append(f"missing-frame:{frame_type}")
                    if requested_tags:
                        advertised = {str(tag) for tag in (conn.capability_tags or []) if str(tag)}
                        missing = sorted(requested_tags - advertised)
                        if missing:
                            reasons.append(f"missing-tags:{','.join(missing)}")

                    eligible = not reasons and path in {"user-owned", "tenant-shared"} if (user_id or tenant_id) else not reasons
                    row = {
                        "eligible": eligible,
                        "path": path,
                        "reasons": reasons,
                        "user_id": candidate_user_id,
                        "tenant_id": conn.tenant_id,
                        "runtime_id": conn.runtime_id or device_id,
                        "runtime_type": conn.runtime_type,
                        "device_id": device_id,
                        "device_name": conn.device_name,
                        "shared": conn.shared,
                        "supported_frame_types": list(conn.supported_frame_types or []),
                        "capability_tags": list(conn.capability_tags or []),
                        "health": _sanitize_metadata(conn.health or {}),
                        "connected_at": conn.connected_at,
                        "last_seen_at": conn.last_seen_at,
                    }
                    candidates.append(row)
                    if eligible and selected is None:
                        selected = row

            if not candidates:
                summary = "No runtimes are connected."
            elif selected:
                summary = f"Selected runtime {selected['runtime_id']} via {selected['path']}."
            else:
                summary = "Runtimes are connected, but none match the requested user/tenant/frame/tag constraints."

            return {
                "status": "ok",
                "summary": summary,
                "request": {
                    "user_id": user_id,
                    "tenant_id": tenant_id,
                    "frame_type": frame_type,
                    "capability_tags": list(capability_tags or []),
                },
                "selected": selected,
                "candidates": candidates,
                "count": len(candidates),
            }

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
                        "health": _sanitize_metadata(conn.health or {}),
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
        clone_credential: dict[str, Any] | None = None,
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
            # P0 #2 — clone (READ) credential rides to a SHARED runtime only.
            shared_only_run_context_extra={"gitCloneCredential": clone_credential} if clone_credential else None,
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
        clone_credential: dict[str, Any] | None = None,
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
            # P0 #2 — clone (READ) credential rides to a SHARED runtime only.
            shared_only_run_context_extra={"gitCloneCredential": clone_credential} if clone_credential else None,
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

    async def dispatch_work_finish_via_laptop(
        self,
        *,
        user_id: str,
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
        request_body: dict[str, Any],
        git_credential: dict[str, Any] | None = None,
        timeout: float = INVOKE_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Send a work-branch finalize to a connected runtime over a
        ``work-finish-branch`` frame and await the response. The runtime runs
        runFinishWorkBranch (commit + push) and returns ``{tool_invocation,
        output}``. Raises LaptopNotConnected when no runtime advertising the frame
        is online (the caller falls back to mcp HTTP).

        P0 #2 — a personal laptop pushes with its OWN local git creds, so the
        brokered ``git_credential`` is forwarded ONLY when the selected runtime is
        SHARED (a shared runtime has no per-user creds and must push as the right
        identity). The shared-vs-laptop decision is made after runtime selection,
        inside _send_frame_await_response (shared_only_extra).
        """
        body, _conn = await self._send_frame_await_response(
            user_id=user_id,
            tenant_id=tenant_id,
            capability_tags=capability_tags,
            frame_type="work-finish-branch",
            payload=request_body,
            timeout=timeout,
            request_label="work-finish-branch",
            require_frame_type="work-finish-branch",
            shared_only_extra={"gitCredential": git_credential} if git_credential else None,
        )
        return body

    async def dispatch_worktree_write_via_laptop(
        self,
        *,
        user_id: str,
        tenant_id: str | None = None,
        capability_tags: list[str] | None = None,
        request_body: dict[str, Any],
        timeout: float = INVOKE_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Send a worktree file write+commit to the user's laptop over a
        ``worktree-write-file`` frame and await the response. The laptop runs
        runWorktreeWriteFile against its LOCAL worktree and returns the
        ``{workItemCode, path, edited, ...}`` payload. Raises LaptopNotConnected
        when no laptop advertising the frame is online (caller falls back to HTTP).
        """
        body, _conn = await self._send_frame_await_response(
            user_id=user_id,
            tenant_id=tenant_id,
            capability_tags=capability_tags,
            frame_type="worktree-write-file",
            payload=request_body,
            timeout=timeout,
            request_label="worktree-write-file",
            require_frame_type="worktree-write-file",
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
        shared_only_extra: dict[str, Any] | None = None,
        shared_only_run_context_extra: dict[str, Any] | None = None,
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

        # P0 #2 — fields that may cross the bridge ONLY to a SHARED runtime, never
        # a personal laptop (Decision #3). A brokered per-user git credential is
        # the sole user today: a shared runtime has no per-user creds of its own
        # and must receive one to push as the right identity; a personal laptop
        # already holds the user's local creds and is deliberately not handed a
        # minted token.
        send_payload = payload
        if shared_only_extra and self._is_shared_runtime(conn):
            send_payload = {**send_payload, **shared_only_extra}
        # Same shared-only gate, but for fields nested under run_context (e.g. the
        # brokered clone credential the mcp consumer reads at run_context.
        # gitCloneCredential). Merged onto a COPY so the caller's payload is never
        # mutated; a personal laptop never receives it.
        if shared_only_run_context_extra and self._is_shared_runtime(conn):
            send_payload = {
                **send_payload,
                "run_context": {**(send_payload.get("run_context") or {}), **shared_only_run_context_extra},
            }

        frame = {"type": frame_type, "request_id": request_id, "payload": send_payload}
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
