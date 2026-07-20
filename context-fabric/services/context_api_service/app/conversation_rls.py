"""
Forced tenant row-level security for the conversation store.

`conversation_store.py` said this out loud in its own docstring: "Conversation
turns are raw user text, so this is the weakest protection on the most sensitive
data in the platform; forced RLS is a tracked follow-up." This module is that
follow-up.

WHY APP-LEVEL SCOPING IS NOT ENOUGH HERE. The store's tenancy was a `WHERE
tenant_id = ?` that each caller had to remember. That is one forgotten predicate
away from a cross-tenant transcript leak, and the thing it leaks is raw user
text. RLS moves the check from "every caller remembers" to "the database
refuses", which is the only version that survives a new caller being added by
someone who has not read this file.

────────────────────────────────────────────────────────────────────────────
THE CONTRACT, AND WHY IT FAILS CLOSED
────────────────────────────────────────────────────────────────────────────
`app.tenant_id` is set TRANSACTION-LOCAL:

    select set_config('app.tenant_id', %s, true)   -- the `true` is the point

and the policy is `tenant_id = public.cf_current_tenant_id()`, where that
function returns `nullif(current_setting('app.tenant_id', true), '')` — NULL, not
the empty string, when unset.

That NULL is the whole safety property. `tenant_id = NULL` evaluates to NULL,
which is not true, so a session that never set a tenant matches NOTHING:

    reads  -> 0 rows
    writes -> WITH CHECK violation

An unscoped caller therefore gets an empty result, never someone else's
transcript. This is fail-closed BY CONSTRUCTION rather than by remembering to add
a guard at each call site — which matters, because a forgotten guard is exactly
the failure this replaces.

FORCE, not merely ENABLE. Without FORCE, the table OWNER bypasses its own
policies. CF connects as a single role that is normally the owner, so plain
ENABLE would show up correctly in `pg_policies` and isolate nothing at runtime.
That is the failure mode most likely to be mistaken for success, so
`verify_rls()` checks `relforcerowsecurity`, not just `relrowsecurity`.

────────────────────────────────────────────────────────────────────────────
POSTGRES ONLY — a real gap, stated rather than papered over
────────────────────────────────────────────────────────────────────────────
`conversation_store` targets Postgres OR SQLite (the standalone/dev default is
`./data/conversations.db`). SQLite has no row-level security of any kind. On that
backend `tenant_scoped_conn` is a plain connection and tenancy stays app-level.

This is not a technicality to be glossed: a deployment holding regulated
conversation data must run the store on Postgres. `tenant_scoped_conn` therefore
does not pretend — it reports the backend, and `rls_supported()` answers the
question directly for anyone who needs to branch on it.

────────────────────────────────────────────────────────────────────────────
ROLLOUT
────────────────────────────────────────────────────────────────────────────
Two files, mirroring workgraph's split (see sql/conversation_rls_policies.sql for
why the shape was borrowed rather than invented):

  sql/conversation_rls_policies.sql  — INERT. Creates the helper function and the
                                       two policies. A policy does nothing until
                                       RLS is forced, so applying this has no
                                       runtime effect.
  sql/conversation_rls_cutover.sql   — GUARDED. ENABLE + FORCE, behind four
                                       preflight guards, aborting with zero
                                       changes if any fails.

Driven by `bin/enable-cf-conversation-forced-rls.py`, which is dry-run by default
and mirrors `bin/enable-workgraph-forced-rls.py`.
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from context_fabric_shared.database import (
    DatabaseConnection,
    db_conn,
    is_postgres_target,
)


TENANT_SETTING = "app.tenant_id"

RLS_TABLES = ("cf_conversations", "cf_conversation_turns")
POLICY_NAME = "tenant_isolation_policy"

_SQL_DIR = Path(__file__).resolve().parent / "sql"
POLICY_SCAFFOLD_PATH = _SQL_DIR / "conversation_rls_policies.sql"
CUTOVER_PATH = _SQL_DIR / "conversation_rls_cutover.sql"


def rls_supported(target: str) -> bool:
    """Whether this store target can enforce RLS at all.

    False for SQLite. Callers that need a hard guarantee should refuse to start
    rather than assume — see the module docstring.
    """
    return is_postgres_target(target)


@contextmanager
def tenant_scoped_conn(
    target: str, tenant_id: Optional[str],
) -> Iterator[DatabaseConnection]:
    """A store connection whose transaction is scoped to ``tenant_id``.

    On Postgres this issues `set_config('app.tenant_id', ..., true)` as the FIRST
    statement of the transaction, so every subsequent read and write in the block
    is filtered by the tenant policy. `db_conn` commits at block exit, which ends
    the transaction and therefore the setting — no leakage into a pooled
    connection's next user.

    `tenant_id=None` is passed through as '' ON PURPOSE, which
    `cf_current_tenant_id()` turns into NULL, which matches no rows. An unscoped
    caller must see nothing, not everything. Raising here instead would be worse:
    it would push every caller into inventing a default tenant, which is how
    cross-tenant reads get reintroduced.

    On SQLite this is a plain connection. There is no RLS to scope.
    """
    with db_conn(target) as conn:
        if conn.is_postgres:
            # Parameterised, not interpolated: `SET LOCAL` takes no parameters,
            # which is exactly why set_config() is the right call — a tenant id
            # is caller-supplied data and must never be concatenated into SQL.
            conn.execute(
                "SELECT set_config(%s, %s, true)",
                (TENANT_SETTING, tenant_id or ""),
            )
        yield conn


def current_tenant(conn: DatabaseConnection) -> Optional[str]:
    """The tenant this transaction is scoped to, as the DATABASE sees it.

    Reads through `cf_current_tenant_id()` rather than the raw setting, so a test
    asserting on this is asserting on the same expression the policy evaluates.
    """
    if not conn.is_postgres:
        return None
    row = conn.execute("SELECT public.cf_current_tenant_id() AS tenant").fetchone()
    if row is None:
        return None
    return dict(row).get("tenant")


def _read_sql(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def install_policies(target: str) -> None:
    """Apply the INERT policy scaffold. No runtime effect on its own.

    Idempotent: the scaffold guards every CREATE POLICY behind a pg_policies
    existence check, so re-running is safe.
    """
    if not rls_supported(target):
        raise RuntimeError(
            f"conversation RLS requires a Postgres target; got {target!r}. "
            "SQLite has no row-level security."
        )
    sql = _read_sql(POLICY_SCAFFOLD_PATH)
    with db_conn(target) as conn:
        conn.raw.execute(sql)


def force_rls(target: str) -> None:
    """Run the GUARDED cutover: ENABLE + FORCE behind its preflight.

    Aborts with zero changes if any guard fails — the whole file is one
    transaction and the guards RAISE.
    """
    if not rls_supported(target):
        raise RuntimeError(
            f"conversation RLS requires a Postgres target; got {target!r}."
        )
    sql = _read_sql(CUTOVER_PATH)
    with db_conn(target) as conn:
        # The cutover file manages its own BEGIN/COMMIT.
        conn.raw.autocommit = True
        try:
            conn.raw.execute(sql)
        finally:
            conn.raw.autocommit = False


def verify_rls(target: str) -> dict[str, dict[str, bool]]:
    """Structural check: per table, does the policy exist and is FORCE on?

    Returns {table: {"policy": bool, "enabled": bool, "forced": bool}}.

    `forced` is reported separately from `enabled` deliberately. ENABLE alone
    leaves the table owner bypassing its own policies, which looks correct in
    pg_policies and isolates nothing — so a caller that checks only `enabled`
    would be reporting a green light for an unprotected table.
    """
    if not rls_supported(target):
        raise RuntimeError(
            f"conversation RLS requires a Postgres target; got {target!r}."
        )
    out: dict[str, dict[str, bool]] = {}
    with db_conn(target) as conn:
        for table in RLS_TABLES:
            row = conn.execute(
                """
                SELECT c.relrowsecurity AS enabled,
                       c.relforcerowsecurity AS forced
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = %s
                """,
                (table,),
            ).fetchone()
            policy = conn.execute(
                """
                SELECT count(*) AS n
                  FROM pg_policies
                 WHERE schemaname = 'public'
                   AND tablename = %s
                   AND policyname = %s
                """,
                (table, POLICY_NAME),
            ).fetchone()
            data = dict(row) if row else {}
            out[table] = {
                "policy": int(dict(policy).get("n", 0)) > 0 if policy else False,
                "enabled": bool(data.get("enabled", False)),
                "forced": bool(data.get("forced", False)),
            }
    return out
