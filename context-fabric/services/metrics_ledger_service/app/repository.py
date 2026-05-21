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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_calls (
                id TEXT PRIMARY KEY,
                trace_id TEXT,
                run_id TEXT,
                capability_id TEXT,
                capability_type TEXT,
                workflow_id TEXT,
                stage_key TEXT,
                provider TEXT,
                model_name TEXT,
                model_alias TEXT,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cached_input_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost REAL NOT NULL DEFAULT 0,
                latency_ms INTEGER,
                converged INTEGER NOT NULL DEFAULT 0,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_llm_calls_capability ON llm_calls(capability_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);")
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(llm_calls)").fetchall()}
        if "capability_type" not in cols:
            conn.execute("ALTER TABLE llm_calls ADD COLUMN capability_type TEXT;")


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


def insert_llm_call(data: dict) -> str:
    call_id = data.get("id") or str(uuid.uuid4())
    with sqlite_conn(settings.db_path) as conn:
        conn.execute(
            """
            INSERT INTO llm_calls
            (id, trace_id, run_id, capability_id, capability_type, workflow_id, stage_key, provider, model_name,
             model_alias, input_tokens, output_tokens, cached_input_tokens, cache_read_tokens,
             cache_write_tokens, estimated_cost, latency_ms, converged, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                call_id,
                data.get("trace_id"),
                data.get("run_id"),
                data.get("capability_id"),
                data.get("capability_type"),
                data.get("workflow_id"),
                data.get("stage_key"),
                data.get("provider"),
                data.get("model_name"),
                data.get("model_alias"),
                int(data.get("input_tokens") or 0),
                int(data.get("output_tokens") or 0),
                int(data.get("cached_input_tokens") or 0),
                int(data.get("cache_read_tokens") or 0),
                int(data.get("cache_write_tokens") or 0),
                float(data.get("estimated_cost") or 0.0),
                data.get("latency_ms"),
                1 if data.get("converged") else 0,
                data.get("metadata_json") or "{}",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
    return call_id


def list_llm_calls(where: str = "", params: tuple = (), limit: int = 100) -> list[dict]:
    sql = "SELECT * FROM llm_calls " + where + " ORDER BY created_at DESC LIMIT ?"
    with sqlite_conn(settings.db_path) as conn:
        rows = conn.execute(sql, (*params, limit)).fetchall()
    return rows_to_dicts(rows)


def llm_cost_per_converged_capability(capability_id: str | None = None) -> dict:
    where = "WHERE converged = 1"
    params: tuple = ()
    if capability_id:
        where += " AND capability_id = ?"
        params = (capability_id,)
    with sqlite_conn(settings.db_path) as conn:
        row = conn.execute(
            f"""
            SELECT
              COUNT(DISTINCT capability_id) AS converged_capabilities,
              COALESCE(SUM(estimated_cost), 0) AS total_cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
            FROM llm_calls {where}
            """,
            params,
        ).fetchone()
    data = row_to_dict(row) or {}
    count = data.get("converged_capabilities") or 0
    data["cost_per_converged_capability"] = (data.get("total_cost") or 0) / count if count else 0
    return data


def llm_cost_per_converged_capability_type(capability_type: str | None = None) -> list[dict]:
    where = "WHERE converged = 1"
    params: tuple = ()
    if capability_type:
        where += " AND capability_type = ?"
        params = (capability_type,)
    with sqlite_conn(settings.db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT
              capability_type,
              COUNT(DISTINCT capability_id) AS converged_capabilities,
              COALESCE(SUM(estimated_cost), 0) AS total_cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
            FROM llm_calls {where}
            GROUP BY capability_type
            ORDER BY total_cost DESC
            """,
            params,
        ).fetchall()
    out = rows_to_dicts(rows)
    for row in out:
        count = row.get("converged_capabilities") or 0
        row["cost_per_converged_capability"] = (row.get("total_cost") or 0) / count if count else 0
    return out
