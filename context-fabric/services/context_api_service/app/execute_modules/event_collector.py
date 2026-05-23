"""
M73 — event collection.

Two parallel paths funnel mcp-server's per-tool / per-LLM events into
context-fabric's events_store so workgraph-api + Workbench can render
them in real time:

  live_subscribe   — opens a WS to mcp-server on /mcp/ws, subscribes to a
                     specific trace_id, persists each event as it arrives.
                     Runs concurrently with /mcp/invoke. Stop signal is
                     `stop_event` (set by the orchestrator when invoke
                     returns).
  drain_mcp_events — post-invoke HTTP GET on /mcp/events to backfill
                     anything the WS missed (handshake delay, transient
                     disconnect). Idempotent — events_store.upsert_many
                     dedupes by event id.

Both are best-effort: any failure leaves events_store empty for that trace
without surfacing an error to the caller. The /events SSE stream in
execute.py reads from events_store, so the worst case is a stage that
shows no per-tool bubbles in Workbench — the run itself completes fine.
"""
from __future__ import annotations

import asyncio
import json

import httpx

from .. import events_store


async def drain_mcp_events(
    mcp_base_url: str,
    mcp_bearer: str,
    trace_id: str,
) -> int:
    """Pull events for this trace from the MCP server's ring and persist to
    our events_store. Best-effort: failures here don't fail the /execute
    response (the call already succeeded by the time we drain)."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{mcp_base_url.rstrip('/')}/mcp/events",
                params={"trace_id": trace_id, "limit": 1000},
                headers={"Authorization": f"Bearer {mcp_bearer}"},
            )
            resp.raise_for_status()
            payload = resp.json()
        items = (payload.get("data") or {}).get("items") or []
        if not items:
            return 0
        # MCP returns reverse-chrono; we want chronological for the store.
        items_chrono = list(reversed(items))
        return events_store.upsert_many(items_chrono)
    except Exception:
        return 0


async def live_subscribe(
    mcp_base_url: str,
    mcp_bearer: str,
    trace_id: str,
    stop_event: asyncio.Event,
) -> int:
    """Open a WS to MCP, subscribe to this trace, persist events as they
    arrive — until /mcp/invoke returns and stop_event is set.

    Best-effort. If the WS fails (no library, MCP doesn't speak WS, network
    blip), the post-invoke HTTP drain still picks up everything from the
    MCP ring. Returns the count of live-persisted events.
    """
    # Imported lazily so absence (e.g. minimal CI image) doesn't break
    # module loading. The HTTP drain still works without websockets.
    import websockets  # pylint: disable=import-outside-toplevel

    persisted = 0
    # http(s):// → ws(s):// (preserve port + path = /mcp/ws)
    ws_url = mcp_base_url.rstrip("/")
    if ws_url.startswith("https://"):
        ws_url = "wss://" + ws_url[len("https://"):]
    elif ws_url.startswith("http://"):
        ws_url = "ws://" + ws_url[len("http://"):]
    ws_url += "/mcp/ws"

    try:
        # Some clients send Authorization on handshake; the MCP also
        # accepts the subprotocol form which is the only option from a
        # browser.
        async with websockets.connect(
            ws_url,
            subprotocols=[f"bearer.{mcp_bearer}"],
            additional_headers={"Authorization": f"Bearer {mcp_bearer}"},
            close_timeout=2.0,
        ) as ws:
            await ws.send(json.dumps({
                "type": "subscribe.events",
                "filter": {"trace_id": trace_id},
            }))
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("type") == "event":
                    ev = msg.get("event")
                    if ev:
                        events_store.upsert_many([ev])
                        persisted += 1
    except Exception:
        # Subscriber failed; the post-invoke drain will fill in the gaps.
        pass
    return persisted
