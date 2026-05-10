"""
CallLog — durable per-execution audit row (M8).

Captures the full correlation chain produced by a single workgraph
AGENT_TASK invocation flowing through context-fabric:

  workflow_run_id  →  agent_run_id  →  cf_call_id  →
  prompt_assembly_id  →  mcp_invocation_id  →  llm_call_ids[]  →
  tool_invocation_ids[]  →  artifact_ids[]

One row per /execute call. Lookups by trace_id and workflow_run_id are
the primary access patterns.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from context_fabric_shared.sqlite import sqlite_conn, row_to_dict, rows_to_dicts


DB_PATH = os.environ.get("CALL_LOG_DB", "/data/call_log.db")


def init_db() -> None:
    with sqlite_conn(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS call_log (
                id TEXT PRIMARY KEY,
                trace_id TEXT,
                workflow_run_id TEXT,
                workflow_node_id TEXT,
                agent_run_id TEXT,
                capability_id TEXT,
                agent_template_id TEXT,
                session_id TEXT,
                prompt_assembly_id TEXT,
                mcp_server_id TEXT,
                mcp_invocation_id TEXT,
                llm_call_ids_json TEXT NOT NULL,
                tool_invocation_ids_json TEXT NOT NULL,
                artifact_ids_json TEXT NOT NULL,
                code_change_ids_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL,
                finish_reason TEXT,
                final_response TEXT,
                steps_taken INTEGER,
                input_tokens INTEGER,
                output_tokens INTEGER,
                total_tokens INTEGER,
                estimated_cost REAL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                error TEXT,
                continuation_token TEXT,
                pending_tool_name TEXT,
                pending_tool_args_json TEXT
            );
            """
        )
        # Older databases predate the M9.z columns; add idempotently.
        for stmt in (
            "ALTER TABLE call_log ADD COLUMN continuation_token TEXT",
            "ALTER TABLE call_log ADD COLUMN pending_tool_name TEXT",
            "ALTER TABLE call_log ADD COLUMN pending_tool_args_json TEXT",
            "ALTER TABLE call_log ADD COLUMN code_change_ids_json TEXT NOT NULL DEFAULT '[]'",
        ):
            try:
                conn.execute(stmt)
            except Exception:
                pass  # already present
        conn.execute("CREATE INDEX IF NOT EXISTS idx_call_log_trace ON call_log(trace_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_call_log_workflow ON call_log(workflow_run_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_call_log_session ON call_log(session_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_call_log_continuation ON call_log(continuation_token);")


def insert(record: dict) -> str:
    row_id = record.get("id") or str(uuid.uuid4())
    started_at = record.get("started_at") or datetime.now(timezone.utc).isoformat()
    pending_args = record.get("pending_tool_args")
    pending_args_json = json.dumps(pending_args) if pending_args is not None else None
    with sqlite_conn(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO call_log (
                id, trace_id, workflow_run_id, workflow_node_id, agent_run_id,
                capability_id, agent_template_id, session_id,
                prompt_assembly_id, mcp_server_id, mcp_invocation_id,
                llm_call_ids_json, tool_invocation_ids_json, artifact_ids_json,
                code_change_ids_json,
                status, finish_reason, final_response, steps_taken,
                input_tokens, output_tokens, total_tokens, estimated_cost,
                started_at, completed_at, error,
                continuation_token, pending_tool_name, pending_tool_args_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row_id,
                record.get("trace_id"),
                record.get("workflow_run_id"),
                record.get("workflow_node_id"),
                record.get("agent_run_id"),
                record.get("capability_id"),
                record.get("agent_template_id"),
                record.get("session_id"),
                record.get("prompt_assembly_id"),
                record.get("mcp_server_id"),
                record.get("mcp_invocation_id"),
                json.dumps(record.get("llm_call_ids") or []),
                json.dumps(record.get("tool_invocation_ids") or []),
                json.dumps(record.get("artifact_ids") or []),
                json.dumps(record.get("code_change_ids") or []),
                record.get("status", "UNKNOWN"),
                record.get("finish_reason"),
                record.get("final_response"),
                record.get("steps_taken"),
                record.get("input_tokens"),
                record.get("output_tokens"),
                record.get("total_tokens"),
                record.get("estimated_cost"),
                started_at,
                record.get("completed_at"),
                record.get("error"),
                record.get("continuation_token"),
                record.get("pending_tool_name"),
                pending_args_json,
            ),
        )
    return row_id


def update_after_resume(call_id: str, record: dict) -> None:
    """Update an existing call_log row in place — used by /execute/resume to
    write the post-resume status/IDs/tokens without losing the original
    started_at / workflow correlation."""
    pending_args = record.get("pending_tool_args")
    pending_args_json = json.dumps(pending_args) if pending_args is not None else None
    with sqlite_conn(DB_PATH) as conn:
        conn.execute(
            """
            UPDATE call_log SET
                mcp_invocation_id = COALESCE(?, mcp_invocation_id),
                llm_call_ids_json = ?,
                tool_invocation_ids_json = ?,
                artifact_ids_json = ?,
                code_change_ids_json = ?,
                status = ?,
                finish_reason = ?,
                final_response = ?,
                steps_taken = ?,
                input_tokens = ?,
                output_tokens = ?,
                total_tokens = ?,
                completed_at = ?,
                error = ?,
                continuation_token = ?,
                pending_tool_name = ?,
                pending_tool_args_json = ?
            WHERE id = ?
            """,
            (
                record.get("mcp_invocation_id"),
                json.dumps(record.get("llm_call_ids") or []),
                json.dumps(record.get("tool_invocation_ids") or []),
                json.dumps(record.get("artifact_ids") or []),
                json.dumps(record.get("code_change_ids") or []),
                record.get("status", "UNKNOWN"),
                record.get("finish_reason"),
                record.get("final_response"),
                record.get("steps_taken"),
                record.get("input_tokens"),
                record.get("output_tokens"),
                record.get("total_tokens"),
                record.get("completed_at"),
                record.get("error"),
                record.get("continuation_token"),
                record.get("pending_tool_name"),
                pending_args_json,
                call_id,
            ),
        )


def get_by_continuation_token(token: str) -> Optional[dict]:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute("SELECT * FROM call_log WHERE continuation_token = ? ORDER BY started_at DESC LIMIT 1", (token,))
        row = row_to_dict(cur.fetchone())
        if not row:
            return None
        for k in ("llm_call_ids_json", "tool_invocation_ids_json", "artifact_ids_json", "code_change_ids_json"):
            out_key = k[:-5]
            try:
                row[out_key] = json.loads(row[k] or "[]")
            except Exception:
                row[out_key] = []
            del row[k]
        try:
            row["pending_tool_args"] = json.loads(row.get("pending_tool_args_json") or "null")
        except Exception:
            row["pending_tool_args"] = None
        row.pop("pending_tool_args_json", None)
        return row


def _hydrate(row: Optional[dict]) -> Optional[dict]:
    if not row:
        return None
    for k in ("llm_call_ids_json", "tool_invocation_ids_json", "artifact_ids_json", "code_change_ids_json"):
        out_key = k[:-5]  # strip trailing "_json"
        try:
            row[out_key] = json.loads(row[k] or "[]")
        except Exception:
            row[out_key] = []
        del row[k]
    return row


def get_by_id(call_id: str) -> Optional[dict]:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute("SELECT * FROM call_log WHERE id = ?", (call_id,))
        return _hydrate(row_to_dict(cur.fetchone()))


def list_by_trace(trace_id: str, limit: int = 50) -> list[dict]:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute(
            "SELECT * FROM call_log WHERE trace_id = ? ORDER BY started_at DESC LIMIT ?",
            (trace_id, limit),
        )
        return [r for r in (_hydrate(d) for d in rows_to_dicts(cur.fetchall())) if r]


def list_by_workflow(workflow_run_id: str, limit: int = 50) -> list[dict]:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute(
            "SELECT * FROM call_log WHERE workflow_run_id = ? ORDER BY started_at DESC LIMIT ?",
            (workflow_run_id, limit),
        )
        return [r for r in (_hydrate(d) for d in rows_to_dicts(cur.fetchall())) if r]


def list_recent(limit: int = 50) -> list[dict]:
    with sqlite_conn(DB_PATH) as conn:
        cur = conn.execute(
            "SELECT * FROM call_log ORDER BY started_at DESC LIMIT ?", (limit,)
        )
        return [r for r in (_hydrate(d) for d in rows_to_dicts(cur.fetchall())) if r]
