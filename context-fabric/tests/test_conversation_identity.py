"""
Which conversation a turn belongs to — and, more importantly, when it belongs to none.

Two rules carry this module, and most of the assertions below defend them:

  1. CF NEVER INVENTS A CONVERSATION. The ten one-shot extractors (spec-gen,
     board-ingestion, impact assessment, reconciliation, consumable-verify,
     discovery, contracts…) are pure functions over their input. Giving them
     history is a correctness regression, not a feature: prior turns would leak
     one document's analysis into the next.

  2. A WORKFLOW CONVERSATION IS SCOPED TO THE INSTANCE, NOT THE NODE. CF's
     existing `wf:{instance}:{node}` derivation gives every node its own mind,
     so ACT cannot see what PLAN concluded — which is exactly what the plumbed
     but never-populated `initial_history` was for.
"""
from __future__ import annotations

import pytest

from context_api_service.app import conversation_identity as ci


# ── Rule 1: statelessness is the default ──────────────────────────────────

def test_no_run_context_is_stateless():
    assert ci.resolve_conversation(None) is None


def test_unknown_surface_is_stateless():
    # spec-generation, reconciliation, discovery, contracts, consumable-verify…
    for surface in ("spec_generation", "reconciliation", "discovery", "contracts", "impact"):
        assert ci.resolve_conversation({"surface": surface}) is None, surface


def test_a_bare_capability_call_is_stateless():
    # No surface, no workflow: a background/infra call. It must not acquire
    # memory just because it happens to name a capability.
    assert ci.resolve_conversation({"capability_id": "cap-1", "tenant_id": "acme"}) is None


def test_known_surface_without_a_scope_id_is_stateless_not_pooled():
    # The subtle one. Falling through to the workflow rule here would merge
    # unrelated chats into one workflow-instance conversation.
    assert ci.resolve_conversation({"surface": "synthesis", "workflow_instance_id": "wf-1"}) is None


# ── Derivation per surface ────────────────────────────────────────────────

@pytest.mark.parametrize(
    "run_context,expected",
    [
        ({"surface": "synthesis", "thread_id": "t1"}, "sy:thread:t1"),
        ({"surface": "ask_sidecar", "thread_id": "t1"}, "sy:thread:t1"),
        ({"surface": "room_copilot", "room_id": "r1"}, "rm:room:r1"),
        ({"surface": "board", "board_id": "b1"}, "bd:board:b1"),
        ({"surface": "planner", "planner_session_id": "p1"}, "pl:session:p1"),
    ],
)
def test_surface_derivation(run_context, expected):
    assert ci.resolve_conversation(run_context)["conversation_id"] == expected


def test_camel_case_keys_are_accepted():
    # The TS callers send camelCase; requiring snake_case would silently produce
    # stateless turns for every one of them.
    assert ci.resolve_conversation({"surface": "synthesis", "threadId": "t9"})["conversation_id"] == "sy:thread:t9"


def test_surface_aliases_mean_no_caller_has_to_change_its_string():
    for alias in ("ask", "Ask_Sidecar", "working_session", "SYNTHESIS"):
        got = ci.resolve_conversation({"surface": alias, "thread_id": "t1"})
        assert got is not None and got["conversation_id"] == "sy:thread:t1", alias


# ── Rule 2: workflow scope is the instance ────────────────────────────────

def test_workflow_conversation_is_the_instance_not_the_node():
    got = ci.resolve_conversation({"workflow_instance_id": "wf-1", "workflow_node_id": "node-7"})
    assert got["conversation_id"] == "wf:instance:wf-1"
    assert "node-7" not in got["conversation_id"]


def test_two_nodes_of_one_instance_share_a_conversation():
    # THE point of the scope change: this is what lets ACT see what PLAN said.
    a = ci.resolve_conversation({"workflow_instance_id": "wf-1", "workflow_node_id": "plan"})
    b = ci.resolve_conversation({"workflow_instance_id": "wf-1", "workflow_node_id": "act"})
    assert a["conversation_id"] == b["conversation_id"]


def test_two_instances_do_not_share_a_conversation():
    a = ci.resolve_conversation({"workflow_instance_id": "wf-1"})
    b = ci.resolve_conversation({"workflow_instance_id": "wf-2"})
    assert a["conversation_id"] != b["conversation_id"]


# ── Precedence ────────────────────────────────────────────────────────────

def test_explicit_id_wins_over_derivation():
    got = ci.resolve_conversation({"surface": "synthesis", "thread_id": "t1"}, explicit_id="custom:1")
    assert got["conversation_id"] == "custom:1"


def test_conversation_id_on_the_run_context_counts_as_explicit():
    got = ci.resolve_conversation({"surface": "synthesis", "thread_id": "t1", "conversation_id": "carried:9"})
    assert got["conversation_id"] == "carried:9"


def test_surface_beats_workflow_when_both_are_present():
    # A synthesis chat launched from inside a workflow is still that chat.
    got = ci.resolve_conversation({"surface": "synthesis", "thread_id": "t1", "workflow_instance_id": "wf-1"})
    assert got["conversation_id"] == "sy:thread:t1"


# ── Key hygiene ───────────────────────────────────────────────────────────

def test_scope_id_cannot_forge_another_surfaces_namespace():
    # Colons are the key's own delimiter. Letting one through would let a
    # thread id claim to be a workflow instance.
    got = ci.resolve_conversation({"surface": "synthesis", "thread_id": "abc:wf:instance:evil"})
    assert got["conversation_id"].count(":") == 2
    assert got["conversation_id"].startswith("sy:thread:")


def test_absurdly_long_scope_ids_are_refused_rather_than_stored():
    got = ci.resolve_conversation({"surface": "synthesis", "thread_id": "x" * 500})
    assert got is None


def test_blank_scope_id_is_stateless():
    for blank in ("", "   ", None):
        assert ci.resolve_conversation({"surface": "synthesis", "thread_id": blank}) is None, repr(blank)


def test_resolution_reports_its_parts():
    got = ci.resolve_conversation({"surface": "room", "room_id": "r1"})
    assert got == {
        "conversation_id": "rm:room:r1",
        "surface": "room_copilot",
        "scope_kind": "room",
        "scope_id": "r1",
    }


# ── The rename is behaviour-preserving ────────────────────────────────────

def test_call_group_id_matches_the_previous_derivation_exactly():
    # Renamed, not changed. Every persisted field downstream keeps the old name
    # (call_log.session_id, receipts.sessionId), so audit consumers see no diff.
    assert ci.call_group_id("wf-1", "node-2", "cf-9") == "wf:wf-1:node-2"
    assert ci.call_group_id(None, None, "cf-9") == "cf:cf-9"
    assert ci.call_group_id("wf-1", None, "cf-9") == "cf:cf-9"
    assert ci.call_group_id(None, "node-2", "cf-9") == "cf:cf-9"


def test_run_context_accepts_the_new_fields():
    from context_api_service.app.execute import RunContext

    rc = RunContext(conversation_id="sy:thread:t1", surface="synthesis")
    assert rc.conversation_id == "sy:thread:t1"
    assert rc.surface == "synthesis"
    # Additive: absent is still valid, so no caller breaks.
    assert RunContext().conversation_id is None
