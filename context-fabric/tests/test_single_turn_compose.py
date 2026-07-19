"""
Routing the verbatim single-turn endpoint through prompt-composer.

Fourteen callers -- planner, synthesis agents, room-copilot, spec-gen, the board
services, event-horizon, discovery, reconciliation -- reach an LLM through
`execute-governed-single-turn`, which by design sent their prompt UNCHANGED. That
made it the one path with no platform layers and no capability grounding.

This is the first change in the consolidation that alters model OUTPUT, so the
tests here are mostly about the two things that keep that safe:

  1. It is OFF by default, and every "cannot compose" path returns to the exact
     verbatim messages the endpoint would have sent anyway.
  2. When it declines, it SAYS SO. A silently-verbatim turn and a composed turn
     look identical from the outside, which would make the rollout unverifiable.
"""
from __future__ import annotations

import pytest

from context_api_service.app.execute_modules import single_turn_compose as stc


@pytest.fixture(autouse=True)
def _clear_flag(monkeypatch):
    monkeypatch.delenv("CF_SINGLE_TURN_COMPOSE", raising=False)


def _rc(**kw):
    base = {"agent_template_id": "tmpl-1", "capability_id": "cap-1"}
    base.update(kw)
    return base


# ── the flag ─────────────────────────────────────────────────────────────────
def test_on_by_default(monkeypatch):
    """Composing is now the intended behaviour. Running these callers verbatim is
    what left planner, synthesis and the board services ungrounded."""
    do, reason = stc.should_compose(_rc(), "you are helpful")
    assert do is True
    assert reason is None


def test_can_be_reverted_by_env(monkeypatch):
    """Revert is an env change, not a redeploy -- the escape hatch survives the
    default flip."""
    for off in ["0", "false", "FALSE", "no", "off"]:
        monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", off)
        do, reason = stc.should_compose(_rc(), "sys")
        assert do is False
        assert reason is None, "an operator-chosen revert is not a warning"


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes", "on"])
def test_enabled_by_the_flag(monkeypatch, flag):
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", flag)
    do, reason = stc.should_compose(_rc(), "you are helpful")
    assert do is True and reason is None


@pytest.mark.parametrize("flag", ["0", "false", "no", "off"])
def test_disabled_values(monkeypatch, flag):
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", flag)
    assert stc.single_turn_compose_enabled() is False


def test_blank_means_the_default_not_disabled(monkeypatch):
    """An empty env var is "unset", not "off" -- otherwise a stray export would
    silently revert composition platform-wide."""
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "")
    assert stc.single_turn_compose_enabled() is True


def test_flag_is_read_per_call(monkeypatch):
    """Read at call time so a rollout can be reverted without a restart -- the
    whole point of shipping this behind a flag."""
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    assert stc.single_turn_compose_enabled() is True
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "false")
    assert stc.single_turn_compose_enabled() is False


# ── per-caller opt-out ───────────────────────────────────────────────────────
@pytest.mark.parametrize("key", ["compose_single_turn", "composeSingleTurn"])
@pytest.mark.parametrize("value", [False, "false", "0", "no", "off", "FALSE"])
def test_a_caller_can_opt_out(monkeypatch, key, value):
    """One caller whose output breaks under composition can keep running while
    it is fixed, instead of the rollout being reverted for everyone."""
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    do, reason = stc.should_compose(_rc(**{key: value}), "sys")
    assert do is False
    assert "opted out" in reason


@pytest.mark.parametrize("value", [True, "true", "1"])
def test_opting_in_explicitly_still_composes(monkeypatch, value):
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    do, _ = stc.should_compose(_rc(compose_single_turn=value), "sys")
    assert do is True


def test_opt_out_cannot_turn_composition_ON(monkeypatch):
    """The env flag is the master switch: with it explicitly off, a run_context
    value must not re-enable a behaviour the operator turned off."""
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "false")
    do, _ = stc.should_compose(_rc(compose_single_turn=True), "sys")
    assert do is False


# ── refusing to compose, loudly ──────────────────────────────────────────────
def test_no_agent_template_is_reported(monkeypatch):
    """The composer resolves layers, model and policy from the template; with no
    template there is nothing to compose against."""
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    do, reason = stc.should_compose({"capability_id": "cap-1"}, "sys")
    assert do is False
    assert "agent_template_id" in reason


def test_camel_case_template_id_is_accepted(monkeypatch):
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    do, _ = stc.should_compose({"agentTemplateId": "tmpl-1"}, "sys")
    assert do is True


def test_oversized_system_prompt_stays_verbatim(monkeypatch):
    """The override layer caps at 4000 chars. Composing would silently DROP
    instructions -- the one outcome worse than not composing at all."""
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    do, reason = stc.should_compose(_rc(), "x" * (stc.MAX_OVERRIDE_LAYER_CHARS + 1))
    assert do is False
    assert "over the" in reason and "kept verbatim" in reason


def test_a_prompt_exactly_at_the_cap_is_composed(monkeypatch):
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    do, _ = stc.should_compose(_rc(), "x" * stc.MAX_OVERRIDE_LAYER_CHARS)
    assert do is True


def test_missing_composer_url_is_reported(monkeypatch):
    monkeypatch.setenv("CF_SINGLE_TURN_COMPOSE", "true")
    monkeypatch.setattr(stc.settings, "composer_url", "", raising=False)
    do, reason = stc.should_compose(_rc(), "sys")
    assert do is False and "composer_url" in reason


# ── the compose payload ──────────────────────────────────────────────────────
def test_caller_prompt_rides_as_a_top_priority_override():
    """This is what makes composition safe for callers: their prompt is not
    replaced, it is ranked ABOVE everything the composer adds."""
    payload = stc.build_compose_payload(
        run_context=_rc(), system_prompt="  you are a planner  ", task="plan it",
        trace_id="t-1", model_overrides={"modelAlias": "fast"},
    )
    layers = payload["overrides"]["additionalLayers"]
    assert layers == [{"layerType": "EXECUTION_OVERRIDE", "content": "you are a planner"}]
    assert payload["task"] == "plan it"
    assert payload["agentTemplateId"] == "tmpl-1"
    assert payload["capabilityId"] == "cap-1"
    assert payload["modelOverrides"] == {"modelAlias": "fast"}


def test_no_system_prompt_means_no_override_layer():
    payload = stc.build_compose_payload(
        run_context=_rc(), system_prompt="   ", task="t", trace_id="t-1", model_overrides=None,
    )
    assert payload["overrides"]["additionalLayers"] == []


def test_tool_discovery_is_disabled():
    """A single turn dispatches no tools, so discovery would spend a tool-service
    round trip on descriptors nothing can call."""
    payload = stc.build_compose_payload(
        run_context=_rc(), system_prompt="s", task="t", trace_id="t-1", model_overrides=None,
    )
    assert payload["toolDiscovery"]["enabled"] is False


def test_trace_id_flows_into_the_workflow_context():
    payload = stc.build_compose_payload(
        run_context=_rc(), system_prompt="s", task="t", trace_id="trace-9", model_overrides=None,
    )
    assert payload["workflowContext"]["traceId"] == "trace-9"
    assert payload["workflowContext"]["instanceId"] == "trace-9", "falls back to the trace when there is no instance"
    assert payload["workflowContext"]["nodeId"] == "single-turn"


def test_grounding_is_attached_only_when_present():
    bare = stc.build_compose_payload(
        run_context=_rc(), system_prompt="s", task="t", trace_id="t", model_overrides=None,
    )
    assert "worldModel" not in bare and "worldModelViews" not in bare

    grounded = stc.build_compose_payload(
        run_context=_rc(), system_prompt="s", task="t", trace_id="t", model_overrides=None,
        world_model={"capabilityId": "cap-1"},
        world_model_views=[{"kind": "development", "title": "Dev", "contentMd": "x"}],
    )
    assert grounded["worldModel"]["capabilityId"] == "cap-1"
    assert len(grounded["worldModelViews"]) == 1


# ── reading the composer's answer ────────────────────────────────────────────
def test_a_good_response_becomes_messages():
    messages, assembly_id, warnings = stc.extract_composed_messages(
        {"data": {"promptAssemblyId": "pa-1", "assembled": {"systemPrompt": "SYS", "message": "MSG"}, "warnings": ["w"]}},
        fallback_task="task",
    )
    assert messages == [{"role": "system", "content": "SYS"}, {"role": "user", "content": "MSG"}]
    assert assembly_id == "pa-1"
    assert warnings == ["w"]


def test_an_unwrapped_body_is_accepted():
    messages, _, _ = stc.extract_composed_messages(
        {"assembled": {"systemPrompt": "SYS"}}, fallback_task="the task",
    )
    assert messages[1]["content"] == "the task", "user message falls back to the task"


@pytest.mark.parametrize(
    "body",
    [
        None,
        "not an object",
        {},
        {"data": {}},
        {"data": {"assembled": {}}},
        {"data": {"assembled": {"systemPrompt": ""}}},
        {"data": {"assembled": {"systemPrompt": "   "}}},
        {"data": {"assembled": {"systemPrompt": 42}}},
    ],
)
def test_an_unusable_response_falls_back_rather_than_half_composing(body):
    """No system prompt means no layers were assembled -- composing gained
    nothing, and going forward with an empty prompt is strictly worse than the
    verbatim path."""
    messages, assembly_id, warnings = stc.extract_composed_messages(body, fallback_task="t")
    assert messages is None
    assert assembly_id is None
    assert warnings and "fallback" in warnings[0]


def test_extraction_never_raises_on_odd_shapes():
    for body in [[], 0, {"data": []}, {"data": {"assembled": []}}, {"data": {"warnings": "not-a-list"}}]:
        stc.extract_composed_messages(body, fallback_task="t")
