"""
Workflow conversations — one instance, one mind.

THE CHANGE THIS BACKS. workgraph's governed-execute-adapter hardcoded
`initial_history: []`, so every workflow node reached the model knowing nothing
about any other node. It now omits the parameter and CF fills the history from
its own store. The consequence is the biggest behaviour change in this effort:
ACT sees what PLAN said.

THE TRAP. There is an obvious-looking way to wire this that silently does
nothing: passing an explicit `conversation_id` in run_context. That takes CF's
explicit branch, which yields `scope_kind: 'explicit'` and — because a workflow
run_context has no `surface` key — `surface: None`. A None surface fails the
CF_CONVERSATION_SURFACES allowlist, so memory is off while looking on. The
derived path yields `surface: 'workflow'` and is addressable by the allowlist.
`test_an_explicit_conversation_id_would_have_broken_the_allowlist` documents
that difference so nobody re-discovers it in production.

THE SCOPE DECISION. A workflow conversation is keyed to the INSTANCE, not the
node. CF's older per-call tag was `wf:{instance}:{node}`, which made every node
its own mind — exactly the thing being fixed. The node id rides along as a
per-turn attribute instead.
"""
from __future__ import annotations

import asyncio

import pytest

from context_api_service.app import conversation_store as cs
from context_api_service.app.conversation_identity import resolve_conversation
from context_api_service.app.governed import conversation_context as ctx


PLAN_RC = {
    "workflow_instance_id": "wfi-1",
    "workflow_node_id": "node-plan",
    "capability_id": "cap-1",
    "tenant_id": "acme",
}
ACT_RC = {**PLAN_RC, "workflow_node_id": "node-act"}


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


def _record(rc, user_text, assistant_text):
    return asyncio.run(ctx.record_turn(rc, user_text=user_text, assistant_text=assistant_text))


# ── identity ────────────────────────────────────────────────────────────────


def test_a_workflow_instance_is_one_conversation_across_its_nodes():
    plan = resolve_conversation(PLAN_RC)
    act = resolve_conversation(ACT_RC)
    assert plan["conversation_id"] == act["conversation_id"] == "wf:instance:wfi-1"
    assert plan["surface"] == "workflow"
    assert plan["scope_kind"] == "instance"


def test_two_instances_do_not_share_a_conversation():
    assert resolve_conversation({**PLAN_RC, "workflow_instance_id": "wfi-2"})["conversation_id"] \
        != resolve_conversation(PLAN_RC)["conversation_id"]


def test_an_explicit_conversation_id_would_have_broken_the_allowlist():
    # Why the adapter deliberately does NOT send conversation_id. Both resolve
    # to the same key, but only the derived one carries a surface — and a None
    # surface is refused by any non-empty allowlist.
    derived = resolve_conversation(PLAN_RC)
    explicit = resolve_conversation({**PLAN_RC, "conversation_id": "wf:instance:wfi-1"})
    assert derived["conversation_id"] == explicit["conversation_id"]
    assert derived["surface"] == "workflow"
    assert explicit["surface"] is None
    assert explicit["scope_kind"] == "explicit"


# ── the behaviour change ────────────────────────────────────────────────────


def test_act_sees_what_plan_said(store):
    """THE point of this change, in one test."""
    _record(PLAN_RC, "plan the ledger work", "I will split it into schema then API")
    prelude = asyncio.run(ctx.build(ACT_RC))
    assert [m["content"] for m in prelude] == [
        "plan the ledger work",
        "I will split it into schema then API",
    ]


def test_a_later_node_sees_every_earlier_node_in_order(store):
    _record({**PLAN_RC, "workflow_node_id": "node-plan"}, "plan it", "the plan")
    _record({**PLAN_RC, "workflow_node_id": "node-design"}, "design it", "the design")
    prelude = asyncio.run(ctx.build({**PLAN_RC, "workflow_node_id": "node-act"}))
    assert [m["content"] for m in prelude] == ["plan it", "the plan", "design it", "the design"]


def test_a_node_on_a_different_instance_sees_nothing(store):
    _record(PLAN_RC, "plan the ledger work", "the plan")
    assert asyncio.run(ctx.build({**ACT_RC, "workflow_instance_id": "wfi-other"})) == []


def test_a_node_with_no_instance_id_stays_stateless(store):
    # A stage invoked outside a workflow instance has no conversation, by
    # design. CF never invents one.
    assert resolve_conversation({"capability_id": "cap-1"}) is None
    assert asyncio.run(ctx.build({"capability_id": "cap-1"})) == []


# ── the allowlist is still the switch ───────────────────────────────────────


def test_the_shipped_allowlist_enables_workflow(store, monkeypatch):
    monkeypatch.setenv(
        "CF_CONVERSATION_SURFACES", "synthesis,room_copilot,board_copilot,planner,workflow"
    )
    _record(PLAN_RC, "plan it", "the plan")
    assert asyncio.run(ctx.build(ACT_RC))


def test_dropping_workflow_from_the_allowlist_restores_independent_nodes(store, monkeypatch):
    # The documented way back: nodes become independent minds again and every
    # other surface keeps working.
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "synthesis,room_copilot,board_copilot,planner")
    _record(PLAN_RC, "plan it", "the plan")
    assert asyncio.run(ctx.build(ACT_RC)) == []
