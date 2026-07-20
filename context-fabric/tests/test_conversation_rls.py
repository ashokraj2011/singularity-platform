"""Forced tenant RLS for the conversation store.

Two tiers:

  * Always-on: the SQL artefacts and the Python contract, checkable without a
    database. These are structural, and they exist mainly to stop the policy
    predicate or the FORCE step being quietly dropped in a later edit.

  * Postgres-gated: the behavioural proof — tenant A cannot read tenant B, and an
    unset tenant sees ZERO rows rather than everything. These are the ones that
    actually matter, and they are SKIPPED unless CF_RLS_TEST_DATABASE_URL points
    at a real database, matching how the workgraph runtime harness gates its
    real-Postgres tests.

To run the gated tier locally:

    initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o "-p 55433 -k /tmp/pgrls" start
    createdb ... ENCODING 'UTF8' TEMPLATE template0
    CF_RLS_TEST_DATABASE_URL=postgresql://... pytest tests/test_conversation_rls.py

TWO ENVIRONMENT TRAPS worth writing down, because both cost real time:

  1. `initdb` needs LC_ALL=C on macOS or it fails at startup, but a cluster
     created that way is SQL_ASCII — and then psycopg returns text columns as
     BYTES. Create the test database explicitly with
     `ENCODING 'UTF8' TEMPLATE template0`.
  2. The behavioural tier MUST connect as a role that is neither SUPERUSER nor
     BYPASSRLS. A superuser bypasses RLS entirely regardless of FORCE, so the
     same test run as `postgres` prints all-green while proving nothing. The
     fixture asserts this rather than trusting it.
"""
from __future__ import annotations

import os
import uuid

import pytest

from context_api_service.app import conversation_rls as rls
from context_api_service.app import conversation_store as cs


PG_URL = os.environ.get("CF_RLS_TEST_DATABASE_URL", "").strip()
requires_pg = pytest.mark.skipif(
    not PG_URL, reason="set CF_RLS_TEST_DATABASE_URL to a Postgres URL to run the behavioural RLS tier",
)


# ── structural: the SQL artefacts ─────────────────────────────────────────


def test_policy_scaffold_exists_and_is_inert():
    """The scaffold must create policies and must NOT enable or force RLS.

    That separation is the whole safety story: applying the scaffold has no
    runtime effect, so it can ship ahead of the cutover.
    """
    sql = rls.POLICY_SCAFFOLD_PATH.read_text()
    assert "CREATE POLICY" in sql or "cf_install_tenant_policy" in sql
    assert "cf_current_tenant_id" in sql
    for table in rls.RLS_TABLES:
        assert table in sql
    # The inert property, asserted directly.
    assert "ENABLE ROW LEVEL SECURITY" not in sql
    assert "FORCE ROW LEVEL SECURITY" not in sql


def test_current_tenant_function_returns_null_when_unset():
    """`nullif(..., '')` is what makes an unscoped session match NO rows. If this
    ever became a plain current_setting(), unset would compare against '' and the
    fail-closed property would be gone."""
    sql = rls.POLICY_SCAFFOLD_PATH.read_text()
    assert "nullif(current_setting('app.tenant_id', true), '')" in sql


def test_cutover_forces_rls_not_merely_enables_it():
    """ENABLE alone leaves the table OWNER bypassing its own policies — the
    failure mode most easily mistaken for success."""
    sql = rls.CUTOVER_PATH.read_text()
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "FORCE ROW LEVEL SECURITY" in sql


def test_cutover_guards_are_all_present():
    sql = rls.CUTOVER_PATH.read_text()
    for guard in ("[Guard A]", "[Guard B]", "[Guard C]", "[Guard D]"):
        assert guard in sql, f"missing {guard}"
    # One transaction: a guard that RAISEs must leave zero changes behind.
    assert "BEGIN;" in sql and "COMMIT;" in sql


def test_cutover_documents_its_rollback():
    assert "NO FORCE ROW LEVEL SECURITY" in rls.CUTOVER_PATH.read_text()


# ── structural: the Python contract ───────────────────────────────────────


def test_rls_supported_is_postgres_only():
    assert rls.rls_supported("postgresql://u@h/db") is True
    assert rls.rls_supported("postgres://u@h/db") is True
    # SQLite cannot enforce RLS. Saying so is the point — a caller needing a
    # hard guarantee has to be able to find out.
    assert rls.rls_supported("./data/conversations.db") is False


def test_install_and_force_refuse_a_sqlite_target():
    for fn in (rls.install_policies, rls.force_rls, rls.verify_rls):
        with pytest.raises(RuntimeError, match="Postgres"):
            fn("./data/conversations.db")


def test_tenant_scoped_conn_is_a_plain_connection_on_sqlite(tmp_path):
    """SQLite has no RLS; the helper must still work so the dev path is unbroken."""
    db = str(tmp_path / "c.db")
    with rls.tenant_scoped_conn(db, "acme") as conn:
        assert conn.is_postgres is False
        assert rls.current_tenant(conn) is None


# ── the store still works on SQLite ───────────────────────────────────────


@pytest.fixture()
def sqlite_store(tmp_path, monkeypatch):
    db = tmp_path / "conversations.db"
    monkeypatch.setenv("CONVERSATION_STORE_DB", str(db))
    monkeypatch.delenv("CONVERSATION_STORE_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_DATABASE_URL", raising=False)
    cs.refresh_db_target()
    cs.init_db()
    return cs


def test_turn_inherits_the_conversations_tenant(sqlite_store):
    """A turn is stamped with the CONVERSATION's tenant, never the caller's
    claim. This closes the NULL-tenant hole (Guard C) and the split-brain
    transcript (Guard D) at the source, and it works on SQLite too, where
    nothing else would."""
    sqlite_store.ensure_conversation("c1", tenant_id="acme")
    sqlite_store.append_turn("c1", "user", "hello", tenant_id="acme")
    # A caller passing the WRONG tenant must not stamp the turn with it.
    sqlite_store.append_turn("c1", "user", "second", tenant_id="not-acme")
    turns = sqlite_store.recent_turns("c1", 10, tenant_id="acme")
    assert [t["tenant_id"] for t in turns] == ["acme", "acme"]


def test_turn_never_stamped_null_when_conversation_has_a_tenant(sqlite_store):
    sqlite_store.ensure_conversation("c2", tenant_id="acme")
    # Caller omits the tenant entirely.
    sqlite_store.append_turn("c2", "user", "hello")
    turns = sqlite_store.recent_turns("c2", 10, tenant_id="acme")
    assert [t["tenant_id"] for t in turns] == ["acme"]


# ── behavioural: real Postgres ────────────────────────────────────────────


@pytest.fixture()
def pg_store(monkeypatch):
    """A forced-RLS Postgres store, isolated per test by unique conversation ids.

    Asserts the connecting role cannot bypass RLS. Without that assertion a run
    as a superuser would report all-green while testing nothing.
    """
    monkeypatch.setenv("CONVERSATION_STORE_DATABASE_URL", PG_URL)
    monkeypatch.delenv("CONVERSATION_STORE_DB", raising=False)
    cs.refresh_db_target()

    from context_fabric_shared.database import db_conn

    with db_conn(PG_URL) as conn:
        row = conn.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
        flags = dict(row) if row else {}
    if flags.get("rolsuper") or flags.get("rolbypassrls"):
        pytest.fail(
            "CF_RLS_TEST_DATABASE_URL connects as a SUPERUSER/BYPASSRLS role. "
            "That role ignores RLS entirely, so these tests would pass without "
            "proving anything. Point it at an ordinary app role."
        )

    state = rls.verify_rls(PG_URL)
    for table, flags in state.items():
        if not flags["forced"]:
            pytest.fail(
                f"{table} does not have FORCE ROW LEVEL SECURITY. Run "
                "bin/enable-cf-conversation-forced-rls.py --apply --confirm-strict-runtime first."
            )
    return cs


@requires_pg
def test_structural_policies_exist_and_are_forced(pg_store):
    state = rls.verify_rls(PG_URL)
    assert set(state) == set(rls.RLS_TABLES)
    for table, flags in state.items():
        assert flags["policy"] is True, f"{table} has no policy"
        assert flags["enabled"] is True, f"{table} RLS not enabled"
        assert flags["forced"] is True, f"{table} RLS not FORCED"


@requires_pg
def test_tenant_cannot_read_another_tenants_turns(pg_store):
    a, b = f"a-{uuid.uuid4().hex[:8]}", f"b-{uuid.uuid4().hex[:8]}"
    ca, cbid = f"conv:{a}", f"conv:{b}"

    pg_store.ensure_conversation(ca, tenant_id=a)
    pg_store.append_turn(ca, "user", "tenant A private text", tenant_id=a)
    pg_store.ensure_conversation(cbid, tenant_id=b)
    pg_store.append_turn(cbid, "user", "tenant B private text", tenant_id=b)

    # Own data is visible.
    assert [t["content"] for t in pg_store.recent_turns(ca, 10, tenant_id=a)] == [
        "tenant A private text"
    ]
    # The other tenant's is not -- this is the read that feeds a PROMPT.
    assert pg_store.recent_turns(cbid, 10, tenant_id=a) == []
    assert pg_store.get_conversation(cbid, tenant_id=a) is None
    assert pg_store.turns_through(cbid, 999, tenant_id=a) == []


@requires_pg
def test_unset_tenant_sees_zero_rows_not_everything(pg_store):
    """The requirement stated the strong way: not merely 'the WHERE clause
    filters', but that an UNFILTERED count across the whole table returns 0."""
    t = f"t-{uuid.uuid4().hex[:8]}"
    conv = f"conv:{t}"
    pg_store.ensure_conversation(conv, tenant_id=t)
    pg_store.append_turn(conv, "user", "some text", tenant_id=t)

    assert pg_store.get_conversation(conv, tenant_id=None) is None
    assert pg_store.recent_turns(conv, 10, tenant_id=None) == []

    with rls.tenant_scoped_conn(PG_URL, None) as conn:
        assert rls.current_tenant(conn) is None
        n_conv = dict(conn.execute("SELECT count(*) AS n FROM cf_conversations").fetchone())["n"]
        n_turns = dict(conn.execute("SELECT count(*) AS n FROM cf_conversation_turns").fetchone())["n"]
    assert n_conv == 0, "unset tenant must see ZERO conversations, not all of them"
    assert n_turns == 0, "unset tenant must see ZERO turns, not all of them"


@requires_pg
def test_scoped_connection_sees_only_its_own_rows_unfiltered(pg_store):
    """Proves the isolation is RLS and not the app's WHERE clause: a query with
    NO conversation predicate still comes back tenant-scoped."""
    t = f"t-{uuid.uuid4().hex[:8]}"
    conv = f"conv:{t}"
    pg_store.ensure_conversation(conv, tenant_id=t)
    pg_store.append_turn(conv, "user", "one", tenant_id=t)
    pg_store.append_turn(conv, "assistant", "two", tenant_id=t)

    with rls.tenant_scoped_conn(PG_URL, t) as conn:
        rows = conn.execute("SELECT conversation_id FROM cf_conversations").fetchall()
        assert [dict(r)["conversation_id"] for r in rows] == [conv]
        n = dict(conn.execute("SELECT count(*) AS n FROM cf_conversation_turns").fetchone())["n"]
        assert n == 2


@requires_pg
def test_tenant_cannot_write_into_another_tenants_conversation(pg_store):
    a, b = f"a-{uuid.uuid4().hex[:8]}", f"b-{uuid.uuid4().hex[:8]}"
    cbid = f"conv:{b}"
    pg_store.ensure_conversation(cbid, tenant_id=b)
    pg_store.append_turn(cbid, "user", "B's own turn", tenant_id=b)

    # Under RLS the UPDATE that claims the seq finds no row, so this returns None
    # rather than injecting into another tenant's transcript.
    assert pg_store.append_turn(cbid, "user", "injected by A", tenant_id=a) is None
    assert len(pg_store.recent_turns(cbid, 10, tenant_id=b)) == 1


@requires_pg
def test_unset_tenant_cannot_write(pg_store):
    t = f"t-{uuid.uuid4().hex[:8]}"
    conv = f"conv:{t}"
    pg_store.ensure_conversation(conv, tenant_id=t)
    assert pg_store.append_turn(conv, "user", "unscoped", tenant_id=None) is None
    assert pg_store.recent_turns(conv, 10, tenant_id=t) == []


@requires_pg
def test_summary_watermark_is_tenant_scoped(pg_store):
    a, b = f"a-{uuid.uuid4().hex[:8]}", f"b-{uuid.uuid4().hex[:8]}"
    cbid = f"conv:{b}"
    pg_store.ensure_conversation(cbid, tenant_id=b)
    pg_store.append_turn(cbid, "user", "B text", tenant_id=b)

    # A tries to overwrite B's summary.
    pg_store.set_summary(cbid, "A's injected summary", 1, tenant_id=a)
    row = pg_store.get_conversation(cbid, tenant_id=b)
    assert row is not None
    assert row["summary_text"] is None
