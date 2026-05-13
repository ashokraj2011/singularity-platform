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

    # ── invoke routing ─────────────────────────────────────────────────────
    async def invoke(self, user_id: str, payload: dict[str, Any], timeout: float = INVOKE_TIMEOUT_SEC) -> dict[str, Any]:
        """Forward an /mcp/invoke payload to the user's laptop. Returns the
        response body. Raises LaptopNotConnected if no live connection."""
        conn = await self.any_for_user(user_id)
        if conn is None:
            raise LaptopNotConnected(f"no live laptop mcp-server for user {user_id}")

        request_id = uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        conn.pending[request_id] = fut

        frame = {"type": "invoke", "request_id": request_id, "payload": payload}
        try:
            await conn.ws.send_text(_dump_json(frame))
        except Exception as err:
            conn.pending.pop(request_id, None)
            raise LaptopSendFailed(str(err)) from err

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            conn.pending.pop(request_id, None)
            raise LaptopInvokeTimeout(f"invoke {request_id} timed out after {timeout}s")

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
