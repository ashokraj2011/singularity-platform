"""
Events store (M9.x) — durable mirror of MCP-emitted events on the context-fabric side.

After an `/execute` call completes, context-fabric drains the MCP server's
event ring for the trace and persists each row here. This makes per-step
audit (llm.request/response, tool.invocation.*, artifact.created, run.event,
approval.wait.*) queryable AFTER the customer-deployed MCP server has
restarted or rotated its ring buffer.

Schema mirrors the MCP envelope shape, with the id used as primary key so
re-draining (idempotent) is a no-op.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from context_fabric_shared.sqlite import sqlite_conn, row_to_dict, rows_to_dicts


DB_PATH = os.environ.get("EVENTS_STORE_DB", "/data/call_log_events.db")


def init_db() -> None:
    with sqlite_conn(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                severity TEXT,
                trace_id TEXT,
                run_id TEXT,
                run_step_id TEXT,
                work_item_id TEXT,
                agent_id TEXT,
                capability_id TEXT,
                tenant_id TEXT,
                mcp_invocation_id TEXT,
                tool_invocation_id TEXT,
                artifact_id TEXT,
                llm_call_id TEXT,
                payload_json TEXT NOT NULL,
                inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            """
        )
        try:
            conn.execute("ALTER TABLE events ADD COLUMN tenant_id TEXT")
        except Exception:
            pass
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_inserted ON events(inserted_at);")


def upsert_many(events: list[dict]) -> int:
    """Insert events; rows already present (same id) are skipped silently.
    Returns the number of new rows actually written."""
    if not events:
        return 0
    written = 0
    with sqlite_conn(DB_PATH) as conn:
        for ev in events:
            corr = ev.get("correlation") or {}
            try:
                conn.execute(
                    """
                    INSERT INTO events (
                        id, kind, timestamp, severity,
                        trace_id, run_id, run_step_id, work_item_id,
                        agent_id, capability_id, tenant_id,
                        mcp_invocation_id, tool_invocation_id, artifact_id, llm_call_id,
                        payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        ev.get("id"),
                        ev.get("kind"),
                        ev.get("timestamp"),
                        ev.get("severity") or "info",
                        corr.get("traceId"),
                        corr.get("runId"),
                        corr.get("runStepId"),
                        corr.get("workItemId"),
                        corr.get("agentId"),
                        corr.get("capabilityId"),
                        corr.get("tenantId"),
                        corr.get("mcpInvocationId"),
                        corr.get("toolInvocationId"),
                        corr.get("artifactId"),
                        corr.get("llmCallId"),
                        json.dumps(ev.get("payload") or {}),
                    ),
                )
                written += 1
            except Exception:
                # Most likely a duplicate id from a re-drain — silently skip.
                pass
    return written


def _hydrate(row: Optional[dict]) -> Optional[dict]:
    if not row:
        return None
    try:
        row["payload"] = json.loads(row.get("payload_json") or "{}")
    except Exception:
        row["payload"] = {}
    row.pop("payload_json", None)
    return row


def list_by_trace(trace_id: str, since_id: Optional[str] = None,
                  since_timestamp: Optional[str] = None,
                  limit: int = 500,
                  tenant_id: Optional[str] = None) -> list[dict]:
    sql = "SELECT * FROM events WHERE trace_id = ?"
    params: list = [trace_id]
    if tenant_id:
        sql += " AND tenant_id = ?"
        params.append(tenant_id)
    if since_timestamp:
        sql += " AND timestamp > ?"
        params.append(since_timestamp)
    elif since_id:
        # all events with timestamp >= the since_id row's timestamp, then strip the row itself
        sql += " AND timestamp > (SELECT timestamp FROM events WHERE id = ?)"
        params.append(since_id)
    sql += " ORDER BY timestamp ASC LIMIT ?"
    params.append(limit)
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute(sql, params)
        return [r for r in (_hydrate(d) for d in rows_to_dicts(cur.fetchall())) if r]


def list_by_run(run_id: str, limit: int = 500, tenant_id: Optional[str] = None) -> list[dict]:
    sql = "SELECT * FROM events WHERE run_id = ?"
    params: list = [run_id]
    if tenant_id:
        sql += " AND tenant_id = ?"
        params.append(tenant_id)
    sql += " ORDER BY timestamp ASC LIMIT ?"
    params.append(limit)
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute(sql, params)
        return [r for r in (_hydrate(d) for d in rows_to_dicts(cur.fetchall())) if r]


def get_by_id(ev_id: str) -> Optional[dict]:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute("SELECT * FROM events WHERE id = ?", (ev_id,))
        return _hydrate(row_to_dict(cur.fetchone()))


def count_for_trace(trace_id: str) -> int:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute("SELECT COUNT(*) AS c FROM events WHERE trace_id = ?", (trace_id,))
        row = cur.fetchone()
        return int(row["c"] if row else 0)
