from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

from .sqlite import sqlite_conn, row_to_dict, rows_to_dicts


def is_postgres_target(target: str | None) -> bool:
    value = (target or "").strip().lower()
    return value.startswith("postgresql://") or value.startswith("postgres://")


def resolve_database_target(postgres_env: str, sqlite_env: str, default_sqlite_path: str) -> str:
    """Resolve a store target.

    CONTEXT_FABRIC_DATABASE_URL is the shared Postgres default for the
    Context Fabric stores. Store-specific Postgres URLs can override it.
    Legacy SQLite env vars remain as a fallback for standalone/dev runs.
    """
    return (
        os.environ.get(postgres_env)
        or os.environ.get("CONTEXT_FABRIC_DATABASE_URL")
        or os.environ.get(sqlite_env)
        or default_sqlite_path
    )


class DatabaseConnection:
    def __init__(self, raw: Any, backend: str):
        self.raw = raw
        self.backend = backend

    @property
    def is_postgres(self) -> bool:
        return self.backend == "postgres"

    def execute(self, sql: str, params: tuple | list | None = None):
        if self.is_postgres:
            sql = sql.replace("?", "%s")
        return self.raw.execute(sql, params or ())


@contextmanager
def db_conn(target: str) -> Iterator[DatabaseConnection]:
    if is_postgres_target(target):
        import psycopg
        from psycopg.rows import dict_row

        conn = psycopg.connect(target, row_factory=dict_row)
        try:
            yield DatabaseConnection(conn, "postgres")
            conn.commit()
        finally:
            conn.close()
        return

    with sqlite_conn(target) as conn:
        yield DatabaseConnection(conn, "sqlite")
