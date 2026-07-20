"""
The conversation store: durable cross-turn memory for every LLM surface.

Context for why this exists: CF's governed subsystem is stateless. It builds its
message list as `[system_prompt?, user_task]`, so the Ask sidecar, the
Conversational Studio conductor, room-copilot, board-copilot and Event Horizon
all reach the model with zero prior turns.

The assertions that carry weight here are the ones about what must NOT happen:

  - tool traffic is never persisted, so an orphaned tool_result cannot be
    replayed into a later prompt (Anthropic 400s the whole request on those, and
    CF's governed loop has no orphan repair)
  - seq is fenced, so two concurrent appends cannot silently reorder a transcript
  - the summary watermark never moves backwards, so a slow summariser finishing
    late cannot discard newer coverage
  - reads come back oldest-first, because they go straight into a prompt
"""
from __future__ import annotations

import sqlite3
import pytest

from context_api_service.app import conversation_store as cs


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """A real SQLite file per test — this exercises the actual SQL, not a mock."""
    db = tmp_path / "conversations.db"
    monkeypatch.setenv("CONVERSATION_STORE_DB", str(db))
    monkeypatch.delenv("CONVERSATION_STORE_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_DATABASE_URL", raising=False)
    cs.refresh_db_target()
    cs.init_db()
    return cs


def test_sqlite_supports_returning():
    # append_turn claims its seq with UPDATE ... RETURNING, which needs SQLite
    # 3.35+. Asserting the floor directly means a too-old runtime fails with this
    # message rather than an opaque syntax error deep in a turn.
    assert sqlite3.sqlite_version_info >= (3, 35, 0), (
        f"SQLite {sqlite3.sqlite_version} lacks UPDATE ... RETURNING"
    )


def test_init_is_idempotent(store):
    store.init_db()
    store.init_db()
    assert store.get_conversation("nope") is None


def test_ensure_then_append_and_read_back(store):
    store.ensure_conversation("sy:thread:t1", tenant_id="acme", user_id="user:ashok", surface="synthesis")
    assert store.append_turn("sy:thread:t1", "user", "first") == 1
    assert store.append_turn("sy:thread:t1", "assistant", "second") == 2

    turns = store.recent_turns("sy:thread:t1", 10)
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert [t["content"] for t in turns] == ["first", "second"]


def test_reads_come_back_oldest_first(store):
    # Straight into a prompt. Newest-first plus a reverse in the caller is how
    # transcripts end up backwards.
    store.ensure_conversation("c")
    for i in range(5):
        store.append_turn("c", "user", f"m{i}")
    assert [t["content"] for t in store.recent_turns("c", 3)] == ["m2", "m3", "m4"]


def test_ensure_is_idempotent_and_does_not_clobber(store):
    store.ensure_conversation("c", tenant_id="acme", user_id="first-user")
    store.append_turn("c", "user", "hello")
    store.ensure_conversation("c", tenant_id="other", user_id="second-user")

    convo = store.get_conversation("c")
    assert convo["user_id"] == "first-user"   # not overwritten
    assert convo["head_seq"] == 1             # turn survived


def test_tool_traffic_is_never_persisted(store):
    # THE safety property. Nothing that could become an orphaned tool_result
    # ever enters the store, so it can never be replayed into a prompt.
    store.ensure_conversation("c")
    assert store.append_turn("c", "tool", '{"result": "..."}') is None
    assert store.append_turn("c", "system", "you are a helpful assistant") is None
    assert store.recent_turns("c", 10) == []
    assert store.get_conversation("c")["head_seq"] == 0


def test_empty_assistant_turn_is_skipped(store):
    # What a pure tool-call turn looks like once tool_use blocks are stripped.
    # Storing it would put a blank message into the next prompt.
    store.ensure_conversation("c")
    assert store.append_turn("c", "assistant", "") is None
    assert store.append_turn("c", "assistant", "   ") is None
    assert store.get_conversation("c")["head_seq"] == 0


def test_append_without_a_conversation_returns_none(store):
    # Fail quietly rather than orphaning a turn under an id no reader will find.
    assert store.append_turn("never-created", "user", "hi") is None


def test_seq_is_fenced_against_duplicates(store):
    store.ensure_conversation("c")
    seqs = [store.append_turn("c", "user", f"m{i}") for i in range(20)]
    assert seqs == list(range(1, 21))
    assert len(set(seqs)) == 20

    # And the index refuses a hand-written duplicate, so a future writer that
    # forgets to claim through head_seq errors instead of reordering history.
    with cs.db_conn(cs.DB_TARGET) as conn:
        with pytest.raises(Exception):
            conn.execute(
                "INSERT INTO cf_conversation_turns (id, conversation_id, seq, role, content, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                ("dup", "c", 1, "user", "collision", "2026-01-01T00:00:00Z"),
            )


def test_token_totals_accumulate(store):
    store.ensure_conversation("c")
    store.append_turn("c", "user", "a", tokens=10)
    store.append_turn("c", "assistant", "b", tokens=25)
    assert store.get_conversation("c")["total_tokens"] == 35


def test_summary_records_its_watermark(store):
    store.ensure_conversation("c")
    for i in range(6):
        store.append_turn("c", "user", f"m{i}")
    store.set_summary("c", "they discussed onboarding", through_seq=4, tokens=12)

    convo = store.get_conversation("c")
    assert convo["summary_text"] == "they discussed onboarding"
    assert convo["summary_through_seq"] == 4
    assert convo["summary_tokens"] == 12


def test_summary_watermark_never_moves_backwards(store):
    # Two summarisation runs can overlap. If the older one finishes last, taking
    # its result would silently drop the newer one's coverage and re-expand the
    # verbatim tail.
    store.ensure_conversation("c")
    for i in range(10):
        store.append_turn("c", "user", f"m{i}")
    store.set_summary("c", "newer, covers more", through_seq=8)
    store.set_summary("c", "older, stale", through_seq=3)

    convo = store.get_conversation("c")
    assert convo["summary_through_seq"] == 8
    assert convo["summary_text"] == "newer, covers more"


def test_after_seq_selects_the_uncovered_tail(store):
    # How the budget layer asks for "everything the summary does not cover".
    store.ensure_conversation("c")
    for i in range(8):
        store.append_turn("c", "user", f"m{i}")
    tail = store.recent_turns("c", 100, after_seq=5)
    assert [t["content"] for t in tail] == ["m5", "m6", "m7"]


def test_turns_through_returns_the_span_being_summarised(store):
    store.ensure_conversation("c")
    for i in range(6):
        store.append_turn("c", "user", f"m{i}")
    span = store.turns_through("c", 3)
    assert [t["content"] for t in span] == ["m0", "m1", "m2"]


def test_conversations_are_isolated_from_each_other(store):
    store.ensure_conversation("a")
    store.ensure_conversation("b")
    store.append_turn("a", "user", "in-a")
    store.append_turn("b", "user", "in-b")

    assert [t["content"] for t in store.recent_turns("a", 10)] == ["in-a"]
    assert [t["content"] for t in store.recent_turns("b", 10)] == ["in-b"]
    # Independent fences, not a global counter.
    assert store.get_conversation("a")["head_seq"] == 1
    assert store.get_conversation("b")["head_seq"] == 1


def test_zero_limit_reads_nothing(store):
    store.ensure_conversation("c")
    store.append_turn("c", "user", "m")
    assert store.recent_turns("c", 0) == []
