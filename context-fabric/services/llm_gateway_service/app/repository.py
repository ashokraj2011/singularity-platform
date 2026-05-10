from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from context_fabric_shared.sqlite import sqlite_conn, row_to_dict
from .config import settings


def init_db() -> None:
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS model_calls (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model_name TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                estimated_cost REAL NOT NULL,
                latency_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                metadata_json TEXT,
                created_at TEXT NOT NULL
            );
            """
        )


def insert_model_call(provider: str, model_name: str, input_tokens: int, output_tokens: int,
                      estimated_cost: float, latency_ms: int, status: str,
                      metadata: dict | None = None, error: str | None = None) -> str:
    call_id = str(uuid.uuid4())
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO model_calls
            (id, provider, model_name, input_tokens, output_tokens, total_tokens, estimated_cost, latency_ms, status, error, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                call_id, provider, model_name, input_tokens, output_tokens, input_tokens + output_tokens,
                estimated_cost, latency_ms, status, error, json.dumps(metadata or {}), datetime.now(timezone.utc).isoformat()
            ),
        )
    return call_id


def get_model_call(call_id: str) -> dict | None:
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute("SELECT * FROM model_calls WHERE id = ?", (call_id,)).fetchone()
    d = row_to_dict(row)
    if d and d.get("metadata_json"):
        d["metadata"] = json.loads(d.pop("metadata_json"))
    return d
