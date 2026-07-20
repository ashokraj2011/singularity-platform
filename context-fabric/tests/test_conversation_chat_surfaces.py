"""
The chat surfaces, pinned to the run_context they ACTUALLY send.

Every literal in this file was copied from the calling TypeScript, not from the
alias table. That direction matters: a test written against the alias table
proves the table is self-consistent, which it always is. Written against the
caller, it proves the two agree — which is the thing that was broken.

WHAT WAS BROKEN. room-copilot sends `surface: "studio-room"` and board-copilot
(the Chronicler) sends `surface: 'studio-board'`. Neither string was in the
alias table, so `normalize_surface` returned None, `resolve_conversation` fell
through to the workflow rule, found no `workflow_instance_id`, and returned
None. Both surfaces carried a perfectly good `room_id` / `board_id` the whole
time and were still permanently stateless. Enabling the feature flags alone
would have changed nothing for either of them.

WHAT MUST STAY BROKEN. `studio-board-ingest` is one suffix away from
`studio-board` and is a one-shot claim extractor. It must resolve to no
conversation, forever. The same goes for spec-generation, impact assessment and
semantic reconciliation. These tests exist so a future "tidy-up" that replaces
exact matching with a prefix rule fails loudly here instead of silently giving
an extractor cross-document memory.

Source files the literals came from, under workgraph-studio/apps/api/src:
  modules/synthesis/synthesis-agent.service.ts     (Ask sidecar + Conductor)
  modules/rooms/room-copilot.service.ts
  modules/studio/board-moments.service.ts
  modules/studio/board-ingestion.service.ts        (must stay stateless)
  modules/specifications/spec-generation.service.ts        (ditto)
  modules/studio/studio-impact-assessment.service.ts       (ditto)
  modules/reconciliations/reconciliation.semantic.service.ts (ditto)
"""
from __future__ import annotations

import asyncio

import pytest

from context_api_service.app import conversation_store as cs
from context_api_service.app.conversation_identity import resolve_conversation
from context_api_service.app.governed import conversation_context as ctx


# ── run_context literals, copied from the calling TypeScript ────────────────

# synthesis-agent.service.ts:82-87 — the shared build site for BOTH the Ask
# sidecar (ask.service.ts delegates to runAgentTurn) and the Conductor
# (conductor.service.ts:79 delegates to the same).
SYNTHESIS_RC = {
    "surface": "synthesis",
    "workspace_id": "ws-1",
    "thread_id": "th-1",
    "agent_role": "FACILITATOR",
    "user_id": "u-1",
    "capability_id": "cap-synth",
}

# room-copilot.service.ts:26-32
ROOM_RC = {
    "project_id": "prj-1",
    "room_id": "rm-1",
    "capability_id": "studio-room",
    "user_id": "u-1",
    "surface": "studio-room",
}

# board-moments.service.ts:29-34 — the Chronicler.
BOARD_RC = {
    "board_id": "bd-1",
    "capability_id": "studio-chronicler",
    "user_id": "u-1",
    "surface": "studio-board",
}

# board-ingestion.service.ts:44-48 — a one-shot extractor. Note it carries a
# board_id too, so ONLY the surface literal keeps it stateless.
BOARD_INGEST_RC = {
    "board_id": "bd-1",
    "capability_id": "studio-blueprint",
    "surface": "studio-board-ingest",
}


@pytest.fixture()
def store(tmp_path, monkeypatch):
    db = tmp_path / "conversations.db"
    monkeypatch.setenv("CONVERSATION_STORE_DB", str(db))
    monkeypatch.delenv("CONVERSATION_STORE_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_DATABASE_URL", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_SURFACES", raising=False)
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", "true")
    cs.refresh_db_target()
    cs.init_db()
    return cs


def _record(rc, user_text="what did we decide?", assistant_text="the event bus"):
    return asyncio.run(
        ctx.record_turn(rc, user_text=user_text, assistant_text=assistant_text)
    )


# ── each chat surface resolves ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "label,run_context,expected_id,expected_surface",
    [
        ("ask sidecar / conductor", SYNTHESIS_RC, "sy:thread:th-1", "synthesis"),
        ("room-copilot", ROOM_RC, "rm:room:rm-1", "room_copilot"),
        ("board-copilot (Chronicler)", BOARD_RC, "bd:board:bd-1", "board_copilot"),
    ],
)
def test_the_chat_surfaces_resolve_to_a_conversation(
    label, run_context, expected_id, expected_surface
):
    identity = resolve_conversation(run_context)
    assert identity is not None, f"{label} resolved to NO conversation"
    assert identity["conversation_id"] == expected_id
    assert identity["surface"] == expected_surface


@pytest.mark.parametrize(
    "label,run_context",
    [
        ("ask sidecar / conductor", SYNTHESIS_RC),
        ("room-copilot", ROOM_RC),
        ("board-copilot (Chronicler)", BOARD_RC),
    ],
)
def test_each_chat_surface_round_trips_through_the_store(store, label, run_context):
    # End to end on the real store: write a turn, read it back as a prelude.
    assert _record(run_context) == 2
    prelude = asyncio.run(ctx.build(run_context))
    assert [m["content"] for m in prelude] == ["what did we decide?", "the event bus"]


def test_two_rooms_do_not_share_a_conversation(store):
    _record({**ROOM_RC, "room_id": "rm-1"}, user_text="about room one")
    _record({**ROOM_RC, "room_id": "rm-2"}, user_text="about room two")
    one = asyncio.run(ctx.build({**ROOM_RC, "room_id": "rm-1"}))
    assert all("room two" not in m["content"] for m in one)


def test_a_room_and_a_board_with_the_same_id_do_not_collide(store):
    # The `{prefix}:{scope_kind}:{id}` shape exists for exactly this.
    assert resolve_conversation({**ROOM_RC, "room_id": "x"})["conversation_id"] \
        != resolve_conversation({**BOARD_RC, "board_id": "x"})["conversation_id"]


# ── the one-shot extractors must STAY stateless ─────────────────────────────


@pytest.mark.parametrize(
    "label,run_context",
    [
        # One suffix away from studio-board, and carrying a board_id. If exact
        # matching is ever replaced with a prefix rule, this is the test that
        # catches it.
        ("board ingestion (claim extractor)", BOARD_INGEST_RC),
        ("spec generation", {"surface": "spec-generation", "work_item_id": "wi-1"}),
        ("impact assessment", {"surface": "initiative-impact-assessment", "initiative_id": "i-1"}),
        ("semantic reconciliation", {"surface": "semantic-reconciliation", "work_item_id": "wi-1"}),
    ],
)
def test_one_shot_extractors_get_no_conversation(label, run_context):
    assert resolve_conversation(run_context) is None, (
        f"{label} resolved to a conversation; prior turns would leak one "
        f"document's analysis into the next"
    )


def test_an_extractor_writes_nothing_even_with_every_flag_on(store):
    assert _record(BOARD_INGEST_RC) == 0
    assert asyncio.run(ctx.build(BOARD_INGEST_RC)) == []


# ── the allowlist is the blast radius ───────────────────────────────────────


def test_the_shipped_allowlist_covers_exactly_the_three_chat_surfaces(store, monkeypatch):
    # The value docker-compose.yml sets. Workflow and planner stay dark: each
    # has its own, larger cutover.
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "synthesis,room_copilot,board_copilot")
    for run_context in (SYNTHESIS_RC, ROOM_RC, BOARD_RC):
        _record(run_context)
        assert asyncio.run(ctx.build(run_context)), "a chat surface was left dark"


def test_the_shipped_allowlist_leaves_workflow_nodes_dark(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "synthesis,room_copilot,board_copilot")
    workflow_rc = {"workflow_instance_id": "wfi-1", "workflow_node_id": "n-1"}
    # It resolves — workflow conversations are real — but reads stay off until
    # the workflow cutover explicitly adds it to the allowlist.
    assert resolve_conversation(workflow_rc)["surface"] == "workflow"
    _record(workflow_rc)
    assert asyncio.run(ctx.build(workflow_rc)) == []


def test_the_shipped_allowlist_leaves_planner_dark(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "synthesis,room_copilot,board_copilot")
    planner_rc = {"surface": "planner", "planner_session_id": "ps-1"}
    _record(planner_rc)
    assert asyncio.run(ctx.build(planner_rc)) == []
