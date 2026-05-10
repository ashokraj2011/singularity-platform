from __future__ import annotations

import uuid
from datetime import datetime, timezone
from context_fabric_shared.sqlite import sqlite_conn, rows_to_dicts, row_to_dict
from .config import settings


def init_db() -> None:
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS token_savings_runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_id TEXT,
                context_package_id TEXT,
                model_call_id TEXT,
                optimization_mode TEXT NOT NULL,
                raw_input_tokens INTEGER NOT NULL,
                optimized_input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                tokens_saved INTEGER NOT NULL,
                percent_saved REAL NOT NULL,
                estimated_raw_cost REAL NOT NULL,
                estimated_optimized_cost REAL NOT NULL,
                estimated_cost_saved REAL NOT NULL,
                provider TEXT,
                model_name TEXT,
                latency_ms INTEGER,
                quality_score REAL,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_token_savings_session ON token_savings_runs(session_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_token_savings_agent ON token_savings_runs(agent_id);")


def insert_run(data: dict) -> str:
    run_id = str(uuid.uuid4())
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO token_savings_runs
            (id, session_id, agent_id, context_package_id, model_call_id, optimization_mode,
             raw_input_tokens, optimized_input_tokens, output_tokens, tokens_saved, percent_saved,
             estimated_raw_cost, estimated_optimized_cost, estimated_cost_saved, provider, model_name,
             latency_ms, quality_score, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id, data["session_id"], data.get("agent_id"), data.get("context_package_id"), data.get("model_call_id"),
                data["optimization_mode"], data["raw_input_tokens"], data["optimized_input_tokens"], data.get("output_tokens", 0),
                data["tokens_saved"], data["percent_saved"], data.get("estimated_raw_cost", 0.0),
                data.get("estimated_optimized_cost", 0.0), data.get("estimated_cost_saved", 0.0),
                data.get("provider"), data.get("model_name"), data.get("latency_ms"), data.get("quality_score"),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
    return run_id


def list_runs(where: str = "", params: tuple = (), limit: int = 100) -> list[dict]:
    sql = "SELECT * FROM token_savings_runs " + where + " ORDER BY created_at DESC LIMIT ?"
    with sqlite_conn(settings.db_path) as conn:
        rows = conn.execute(sql, (*params, limit)).fetchall()
    return rows_to_dicts(rows)


def aggregate(where: str = "", params: tuple = ()) -> dict:
    sql = f"""
    SELECT
      COUNT(*) AS runs,
      COALESCE(SUM(raw_input_tokens), 0) AS total_raw_tokens,
      COALESCE(SUM(optimized_input_tokens), 0) AS total_optimized_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(tokens_saved), 0) AS total_tokens_saved,
      COALESCE(AVG(percent_saved), 0) AS average_savings_percent,
      COALESCE(SUM(estimated_cost_saved), 0) AS estimated_cost_saved
    FROM token_savings_runs {where}
    """
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute(sql, params).fetchone()
    return row_to_dict(row) or {}


def best_mode() -> str | None:
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute(
            """
            SELECT optimization_mode, AVG(percent_saved) AS avg_savings, COUNT(*) AS cnt
            FROM token_savings_runs
            GROUP BY optimization_mode
            HAVING cnt >= 1
            ORDER BY avg_savings DESC
            LIMIT 1
            """
        ).fetchone()
    return row["optimization_mode"] if row else None
