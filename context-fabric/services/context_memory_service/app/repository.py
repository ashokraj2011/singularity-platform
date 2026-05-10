from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from context_fabric_shared.sqlite import sqlite_conn, rows_to_dicts, row_to_dict
from .config import settings


def init_db() -> None:
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS conversation_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                token_count INTEGER,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON conversation_messages(session_id, created_at);")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS context_summaries (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_id TEXT,
                summary_type TEXT NOT NULL,
                version INTEGER NOT NULL,
                content_json TEXT NOT NULL,
                token_count INTEGER,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_summaries_session ON context_summaries(session_id, version);")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                agent_id TEXT,
                project_id TEXT,
                memory_type TEXT NOT NULL,
                content TEXT NOT NULL,
                importance_score REAL,
                confidence REAL,
                source_type TEXT,
                source_id TEXT,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_items(agent_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_items(session_id);")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS context_packages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_id TEXT,
                optimization_mode TEXT NOT NULL,
                compiled_context_json TEXT NOT NULL,
                raw_context_hash TEXT,
                optimized_context_hash TEXT,
                raw_input_tokens INTEGER NOT NULL,
                optimized_input_tokens INTEGER NOT NULL,
                tokens_saved INTEGER NOT NULL,
                percent_saved REAL NOT NULL,
                included_sections_json TEXT,
                created_at TEXT NOT NULL
            );
            """
        )


def insert_message(session_id: str, agent_id: str | None, role: str, content: str, token_count: int | None = None) -> str:
    mid = str(uuid.uuid4())
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO conversation_messages (id, session_id, agent_id, role, content, token_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (mid, session_id, agent_id, role, content, token_count, datetime.now(timezone.utc).isoformat()),
        )
    return mid


def get_messages(session_id: str, limit: int | None = None, ascending: bool = True) -> list[dict]:
    order = "ASC" if ascending else "DESC"
    sql = f"SELECT * FROM conversation_messages WHERE session_id = ? ORDER BY created_at {order}"
    params: tuple = (session_id,)
    if limit is not None:
        sql += " LIMIT ?"
        params = (session_id, limit)
    with sqlite_conn(settings.db_path) as conn:
        rows = conn.execute(sql, params).fetchall()
    data = rows_to_dicts(rows)
    if not ascending:
        data = list(reversed(data))
    return data


def count_messages_since_summary(session_id: str) -> int:
    latest = get_latest_summary(session_id)
    if not latest:
        with sqlite_conn(settings.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM conversation_messages WHERE session_id = ?", (session_id,)).fetchone()
            return int(row["cnt"])
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM conversation_messages WHERE session_id = ? AND created_at > ?",
            (session_id, latest["created_at"]),
        ).fetchone()
    return int(row["cnt"])


def next_summary_version(session_id: str) -> int:
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute("SELECT MAX(version) AS max_version FROM context_summaries WHERE session_id = ?", (session_id,)).fetchone()
    return int(row["max_version"] or 0) + 1


def insert_summary(session_id: str, agent_id: str | None, summary_type: str, content: dict, token_count: int | None) -> str:
    sid = str(uuid.uuid4())
    version = next_summary_version(session_id)
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO context_summaries (id, session_id, agent_id, summary_type, version, content_json, token_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (sid, session_id, agent_id, summary_type, version, json.dumps(content), token_count, datetime.now(timezone.utc).isoformat()),
        )
    return sid


def get_latest_summary(session_id: str) -> dict | None:
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute(
            "SELECT * FROM context_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    d = row_to_dict(row)
    if d and d.get("content_json"):
        d["content"] = json.loads(d.pop("content_json"))
    return d


def insert_memory_item(data: dict) -> str:
    mem_id = str(uuid.uuid4())
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO memory_items
            (id, session_id, agent_id, project_id, memory_type, content, importance_score, confidence, source_type, source_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                mem_id, data.get("session_id"), data.get("agent_id"), data.get("project_id"), data["memory_type"],
                data["content"], data.get("importance_score", 0.5), data.get("confidence", 0.8), data.get("source_type"),
                data.get("source_id"), datetime.now(timezone.utc).isoformat(),
            ),
        )
    return mem_id


def list_memory_items(agent_id: str | None = None, session_id: str | None = None, limit: int = 100) -> list[dict]:
    clauses = []
    params: list = []
    if agent_id:
        clauses.append("agent_id = ?")
        params.append(agent_id)
    if session_id:
        clauses.append("session_id = ?")
        params.append(session_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"SELECT * FROM memory_items {where} ORDER BY importance_score DESC, created_at DESC LIMIT ?"
    params.append(limit)
    with sqlite_conn(settings.db_path) as conn:
        rows = conn.execute(sql, tuple(params)).fetchall()
    return rows_to_dicts(rows)


def insert_context_package(data: dict) -> str:
    ctx_id = str(uuid.uuid4())
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO context_packages
            (id, session_id, agent_id, optimization_mode, compiled_context_json, raw_context_hash, optimized_context_hash,
             raw_input_tokens, optimized_input_tokens, tokens_saved, percent_saved, included_sections_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ctx_id, data["session_id"], data.get("agent_id"), data["optimization_mode"], json.dumps(data["compiled_context"]),
                data.get("raw_context_hash"), data.get("optimized_context_hash"), data["raw_input_tokens"],
                data["optimized_input_tokens"], data["tokens_saved"], data["percent_saved"],
                json.dumps(data.get("included_sections", [])), datetime.now(timezone.utc).isoformat(),
            ),
        )
    return ctx_id


def get_context_package(ctx_id: str) -> dict | None:
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute("SELECT * FROM context_packages WHERE id = ?", (ctx_id,)).fetchone()
    d = row_to_dict(row)
    if d:
        d["compiled_context"] = json.loads(d.pop("compiled_context_json"))
        d["included_sections"] = json.loads(d.pop("included_sections_json") or "[]")
    return d
