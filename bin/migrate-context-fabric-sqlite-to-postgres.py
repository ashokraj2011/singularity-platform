#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path
from typing import Iterable

import psycopg


ROOT = Path(__file__).resolve().parents[1]
CONTEXT_FABRIC = ROOT / "context-fabric"
sys.path.insert(0, str(CONTEXT_FABRIC))
sys.path.insert(0, str(CONTEXT_FABRIC / "shared"))


DEFAULT_DATABASE_URL = "postgresql://postgres:singularity@localhost:5432/singularity_context_fabric"


def ensure_schema(database_url: str) -> None:
    os.environ["CONTEXT_FABRIC_DATABASE_URL"] = database_url
    from services.context_api_service.app import call_log, events_store
    from services.context_memory_service.app import repository as memory
    from services.metrics_ledger_service.app import repository as metrics

    call_log.init_db()
    events_store.init_db()
    memory.init_db()
    metrics.init_db()


def sqlite_tables(db_path: Path) -> set[str]:
    if not db_path.exists():
        return set()
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {row[0] for row in rows}


def postgres_columns(conn: psycopg.Connection, table: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table,),
    ).fetchall()
    return [row[0] for row in rows]


def sqlite_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def copy_table(sqlite_path: Path, table: str, database_url: str) -> tuple[int, int]:
    if not sqlite_path.exists() or table not in sqlite_tables(sqlite_path):
        return (0, 0)

    with sqlite3.connect(sqlite_path) as source, psycopg.connect(database_url) as target:
        source.row_factory = sqlite3.Row
        src_cols = sqlite_columns(source, table)
        dst_cols = postgres_columns(target, table)
        cols = [col for col in src_cols if col in dst_cols]
        if not cols:
            return (0, 0)

        placeholders = ", ".join(["%s"] * len(cols))
        col_list = ", ".join(cols)
        conflict = "ON CONFLICT (id) DO NOTHING" if "id" in cols else ""
        insert_sql = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) {conflict}"
        rows = source.execute(f"SELECT {col_list} FROM {table}").fetchall()
        inserted = 0
        for row in rows:
            cur = target.execute(insert_sql, tuple(row[col] for col in cols))
            if getattr(cur, "rowcount", 0) > 0:
                inserted += 1
        target.commit()
        return (len(rows), inserted)


def source_plan(base_dir: Path) -> Iterable[tuple[str, Path, list[str]]]:
    yield ("active context-api call log", base_dir / "context_memory" / "call_log.db", ["call_log"])
    yield ("legacy context-api call log", base_dir / "call_log.db", ["call_log"])
    yield ("active context-api events", base_dir / "context_memory" / "call_log_events.db", ["events"])
    yield ("legacy context-api events", base_dir / "call_log_events.db", ["events"])
    yield (
        "context memory",
        base_dir / "context_memory" / "context_memory.db",
        ["conversation_messages", "context_summaries", "memory_items", "context_packages"],
    )
    yield ("metrics ledger", base_dir / "metrics_ledger" / "metrics_ledger.db", ["token_savings_runs", "llm_calls"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill Context Fabric SQLite stores into Postgres.")
    parser.add_argument("--database-url", default=os.environ.get("CONTEXT_FABRIC_DATABASE_URL", DEFAULT_DATABASE_URL))
    parser.add_argument("--base-dir", type=Path, default=ROOT / "context-fabric" / "data")
    args = parser.parse_args()

    ensure_schema(args.database_url)

    total_read = 0
    total_inserted = 0
    for label, db_path, tables in source_plan(args.base_dir):
        if not db_path.exists():
            print(f"skip {label}: {db_path} missing")
            continue
        for table in tables:
            read, inserted = copy_table(db_path, table, args.database_url)
            total_read += read
            total_inserted += inserted
            print(f"{label}: {table}: read={read} inserted={inserted}")

    print(f"done: read={total_read} inserted={total_inserted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
