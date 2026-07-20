"""
B1 — declarative model-selection policy at the gateway.

Before this, the platform had no model selection: twenty-odd `*_MODEL_ALIAS` env
vars each froze one choice at deploy time and the gateway resolved whatever alias
it was handed. This engine turns the task identity that already crosses the hop
(`task_tag`/`stage`/`purpose`) into a routing key.

What is pinned here:

  - the MOST-SPECIFIC `when` wins, and file order breaks ties. Both halves
    matter: without specificity a catch-all shadows every refinement below it;
    without a documented tiebreak an operator cannot predict which of two equal
    rules fires
  - a caller pin (`model_alias`) skips policy ENTIRELY, and `expected_model`
    is never overridden — re-routing a caller that is asserting which model it
    froze against is exactly the bug its drift guard exists to catch
  - size escalation moves exactly ONE rung. It is a guard rail, not a second
    routing system
  - the readiness walk is why tiers are lists: an unready alias is a 503 today,
    and merely a reason the next candidate gets the traffic here
  - DISABLED CHANGES NOTHING. The engine ships dark, and "dark" has to mean the
    resolution path is untouched, not merely that the outcome usually matches
  - a malformed or missing policy file degrades to today's behaviour with a
    warning. A routing layer that can invent an outage from its own bad config
    is worse than no routing layer
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_gateway_service.app import model_policy, provider_config
from llm_gateway_service.app.config import settings


ALL_READY = lambda alias: True  # noqa: E731 — a one-expression test double


@pytest.fixture(autouse=True)
def _clean_policy_state(monkeypatch):
    """Every test starts with no cached policy and the engine ON.

    Individual tests turn it off to assert the dark path; leaving it on by
    default keeps each test about routing rather than about the flag.
    """
    monkeypatch.setenv("GATEWAY_MODEL_POLICY_ENABLED", "true")
    model_policy.reset_cache_for_tests()
    yield
    model_policy.reset_cache_for_tests()


def _write_policy(monkeypatch, tmp_path, policy) -> str:
    path = tmp_path / "llm-policy.json"
    path.write_text(policy if isinstance(policy, str) else json.dumps(policy))
    monkeypatch.setattr(settings, "llm_policy_path", str(path))
    model_policy.reset_cache_for_tests()
    return str(path)


BASE_TIERS = {
    "cheap":    ["claude-haiku-4-5-20251001"],
    "standard": ["claude-sonnet-4-6"],
    "deep":     ["claude-opus-4-1", "claude-sonnet-4-6"],
}


# ── most-specific match wins ────────────────────────────────────────────────
def test_most_specific_when_wins(monkeypatch, tmp_path):
    # Two routes both match. The two-key rule must win over the one-key rule
    # REGARDLESS of file order, or every refinement an operator adds below a
    # broad rule is dead on arrival.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [
            {"when": {"task_tag": "agent_turn"}, "tier": "cheap"},
            {"when": {"task_tag": "agent_turn", "stage": "develop"}, "tier": "deep"},
        ],
    })
    decision = model_policy.resolve(
        task_tag="agent_turn", stage="develop", is_ready=ALL_READY,
    )
    assert decision.tier == "deep"
    assert decision.source == "policy"

    # ...and the broad rule still catches the case the specific one does not.
    other = model_policy.resolve(task_tag="agent_turn", stage="design", is_ready=ALL_READY)
    assert other.tier == "cheap"


def test_specificity_beats_file_order_in_both_directions(monkeypatch, tmp_path):
    # Same two rules, reversed. If specificity were implemented as "last match
    # wins" this would flip, which is exactly the bug this pins.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "routes": [
            {"when": {"task_tag": "agent_turn", "stage": "develop"}, "tier": "deep"},
            {"when": {"task_tag": "agent_turn"}, "tier": "cheap"},
        ],
    })
    decision = model_policy.resolve(task_tag="agent_turn", stage="develop", is_ready=ALL_READY)
    assert decision.tier == "deep"


def test_a_tie_is_broken_by_file_order(monkeypatch, tmp_path):
    # Equal specificity, both matching. The FIRST one wins — an operator reading
    # top-to-bottom must not have a later duplicate silently shadow an earlier
    # rule they are looking straight at.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "routes": [
            {"when": {"task_tag": "summarise"}, "tier": "cheap"},
            {"when": {"task_tag": "summarise"}, "tier": "deep"},
        ],
    })
    assert model_policy.resolve(task_tag="summarise", is_ready=ALL_READY).tier == "cheap"


def test_no_match_falls_to_the_default_tier(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "world_model_distill"}, "tier": "cheap"}],
    })
    decision = model_policy.resolve(task_tag="judge", is_ready=ALL_READY)
    assert decision.tier == "standard"
    assert decision.source == "policy_default"
    assert "no route matched" in decision.reason


def test_route_values_are_normalised_like_task_tags(monkeypatch, tmp_path):
    # The gateway normalises "World-Model Distill" -> world_model_distill on the
    # way in. A policy file written the other way must still match, or the
    # routing key and the cost-aggregation key drift apart.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "routes": [{"when": {"task_tag": "World-Model Distill"}, "tier": "cheap"}],
    })
    assert model_policy.resolve(task_tag="world_model_distill", is_ready=ALL_READY).tier == "cheap"


def test_a_route_with_an_unknown_when_key_is_dropped_not_widened(monkeypatch, tmp_path):
    # Fail closed. Ignoring the unknown key would leave a BROADER rule than the
    # operator wrote — a cheap-tier rule quietly catching production agent
    # turns — which is the dangerous direction to be wrong in.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "judge", "tenant_id": "acme"}, "tier": "cheap"}],
    })
    decision = model_policy.resolve(task_tag="judge", is_ready=ALL_READY)
    assert decision.tier == "standard"
    assert any("tenant_id" in w for w in model_policy.warnings())


# ── precedence ──────────────────────────────────────────────────────────────
def test_a_caller_pin_skips_policy_entirely(monkeypatch, tmp_path):
    # The pin is hard. Even with a route that matches this exact tag, the
    # caller's alias is what comes back and no tier is chosen.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "agent_turn"}, "tier": "deep"}],
    })
    decision = model_policy.resolve(
        model_alias="gpt-4o-mini", task_tag="agent_turn", is_ready=ALL_READY,
    )
    assert decision.source == "caller_pin"
    assert decision.alias == "gpt-4o-mini"
    assert decision.tier is None


def test_expected_model_is_never_overridden(monkeypatch, tmp_path):
    # A replay/immutable caller asserting which model it froze against must not
    # be re-routed — otherwise policy manufactures the exact 409 drift the
    # expected_model guard exists to detect.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "agent_turn"}, "tier": "deep"}],
    })
    decision = model_policy.resolve(
        expected_model="claude-sonnet-4-6", task_tag="agent_turn", is_ready=ALL_READY,
    )
    assert decision.source == "expected_model"
    assert decision.alias is None  # policy supplies nothing; the old path resolves


def test_expected_model_beats_a_tier_hint_too(monkeypatch, tmp_path):
    # A caller sending BOTH is asking for two different things. The hint is a
    # preference; the drift guard is an assertion, and an assertion wins.
    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "standard"})
    decision = model_policy.resolve(
        expected_model="claude-sonnet-4-6", model_tier="deep", is_ready=ALL_READY,
    )
    assert decision.source == "expected_model"


def test_a_tier_hint_is_honoured_over_a_matching_route(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "agent_turn"}, "tier": "cheap"}],
    })
    decision = model_policy.resolve(model_tier="deep", task_tag="agent_turn", is_ready=ALL_READY)
    assert decision.source == "caller_tier"
    assert decision.tier == "deep"
    assert decision.alias == "claude-opus-4-1"


def test_an_undefined_tier_hint_falls_back_to_policy(monkeypatch, tmp_path):
    # A typo'd hint must not be a silent no-op or a hard failure; it warns and
    # policy decides.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "agent_turn"}, "tier": "cheap"}],
    })
    decision = model_policy.resolve(model_tier="platinum", task_tag="agent_turn", is_ready=ALL_READY)
    assert decision.source == "policy"
    assert decision.tier == "cheap"
    assert any("platinum" in w for w in model_policy.warnings())


# ── input-size escalation ───────────────────────────────────────────────────
def test_size_escalation_fires_at_the_threshold_boundary(monkeypatch, tmp_path):
    # Both sides pinned. The field is named ...Exceed, so exactly-at-threshold
    # must NOT fire and one token over must.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "routes": [{"when": {"task_tag": "world_model_distill"}, "tier": "cheap"}],
        "escalateWhenInputTokensExceed": {"cheap": 60000, "standard": 150000},
    })
    at = model_policy.resolve(
        task_tag="world_model_distill", estimated_input_tokens=60000, is_ready=ALL_READY,
    )
    assert at.tier == "cheap"
    assert at.escalated_from is None

    over = model_policy.resolve(
        task_tag="world_model_distill", estimated_input_tokens=60001, is_ready=ALL_READY,
    )
    assert over.tier == "standard"
    assert over.escalated_from == "cheap"
    assert over.as_dict()["escalated_from"] == "cheap"


def test_size_escalation_moves_exactly_one_step(monkeypatch, tmp_path):
    # A 5M-token input blows through BOTH thresholds. It must still land on
    # standard, not deep: escalation is a guard rail, and "as far as it takes"
    # would quietly become a second, unwritten routing system.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "routes": [{"when": {"task_tag": "world_model_distill"}, "tier": "cheap"}],
        "escalateWhenInputTokensExceed": {"cheap": 60000, "standard": 150000},
    })
    decision = model_policy.resolve(
        task_tag="world_model_distill", estimated_input_tokens=5_000_000, is_ready=ALL_READY,
    )
    assert decision.tier == "standard"
    assert decision.escalated_from == "cheap"


def test_the_deepest_tier_has_nowhere_to_escalate_to(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "deep",
        "escalateWhenInputTokensExceed": {"deep": 1000},
    })
    decision = model_policy.resolve(estimated_input_tokens=999_999, is_ready=ALL_READY)
    assert decision.tier == "deep"
    assert decision.escalated_from is None


def test_no_escalation_configured_means_no_escalation(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "cheap"})
    decision = model_policy.resolve(estimated_input_tokens=10_000_000, is_ready=ALL_READY)
    assert decision.tier == "cheap"
    assert "escalated_from" not in decision.as_dict()


@pytest.mark.parametrize(
    "messages,expected",
    [
        (None, 0),
        ([], 0),
        ([{"role": "user", "content": "abcd"}], 1),
        ([{"role": "user", "content": "a" * 4000}], 1000),
        ([{"role": "user", "content": "ab"}, {"role": "assistant", "content": "cd"}], 1),
        ([{"role": "user", "content": None}], 0),
    ],
)
def test_input_size_is_estimated_from_the_messages_already_held(messages, expected):
    # THE one genuinely automatic signal: it separates "distill a README" from
    # "distill a 200-file repo", both of which arrive tagged world_model_distill
    # and only one of which belongs on a cheap model.
    assert model_policy.estimate_input_tokens(messages) == expected


# ── readiness walk ──────────────────────────────────────────────────────────
def test_the_walk_skips_an_unready_candidate(monkeypatch, tmp_path):
    # THE reason tiers are lists. Today an unready alias is a 503 the caller can
    # do nothing about; here it is just why the second entry gets the traffic.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1, "tiers": BASE_TIERS, "defaultTier": "deep",
    })
    decision = model_policy.resolve(is_ready=lambda alias: alias != "claude-opus-4-1")
    assert decision.alias == "claude-sonnet-4-6"
    assert "skipped unready claude-opus-4-1" in decision.reason


def test_nothing_ready_degrades_to_the_old_path(monkeypatch, tmp_path):
    # None means "policy has no opinion" and the pre-policy resolution runs. The
    # alternative — policy manufacturing a failure out of its own state — makes
    # the engine a new outage source rather than a routing layer.
    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "deep"})
    assert model_policy.resolve(is_ready=lambda alias: False) is None
    assert any("no candidate is ready" in w for w in model_policy.warnings())


def test_a_raising_readiness_probe_is_treated_as_unready(monkeypatch, tmp_path):
    # A readiness probe must never be the reason a call fails.
    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "deep"})

    def _boom(alias):
        if alias == "claude-opus-4-1":
            raise RuntimeError("catalog exploded")
        return True

    assert model_policy.resolve(is_ready=_boom).alias == "claude-sonnet-4-6"


# ── the feature gate ────────────────────────────────────────────────────────
@pytest.mark.parametrize("value", ["", "false", "0", "no", "off", "maybe"])
def test_disabled_means_policy_never_decides(monkeypatch, tmp_path, value):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "deep",
        "routes": [{"when": {"task_tag": "agent_turn"}, "tier": "cheap"}],
    })
    monkeypatch.setenv("GATEWAY_MODEL_POLICY_ENABLED", value)
    assert model_policy.policy_enabled() is False
    # Every input that would produce a decision when enabled produces None here.
    assert model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY) is None
    assert model_policy.resolve(model_alias="gpt-4o", is_ready=ALL_READY) is None
    assert model_policy.resolve(model_tier="deep", is_ready=ALL_READY) is None


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_the_gate_accepts_the_usual_truthy_spellings(monkeypatch, value):
    monkeypatch.setenv("GATEWAY_MODEL_POLICY_ENABLED", value)
    assert model_policy.policy_enabled() is True


def test_disabled_leaves_the_resolution_path_untouched(monkeypatch, tmp_path):
    """The strongest form of "changes nothing": the router does not merely reach
    the same answer, it never enters the policy engine at all.

    Asserted by making resolve() detonate. If the dark path were routed through
    it — even to be told "disabled" — this fails.
    """
    from llm_gateway_service.app import router as gw_router

    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "deep"})
    monkeypatch.delenv("GATEWAY_MODEL_POLICY_ENABLED", raising=False)

    def _explode(**_kw):
        raise AssertionError("policy engine consulted while the feature gate is off")

    monkeypatch.setattr(model_policy, "resolve", _explode)
    monkeypatch.setattr(
        gw_router, "_resolve_provider_and_model",
        lambda **kw: ("anthropic", "claude-sonnet-4-6", kw.get("model_alias")),
    )

    from types import SimpleNamespace

    req = SimpleNamespace(model_alias="pinned", provider=None, model=None,
                          expected_model=None, model_tier="deep", messages=[])
    provider, model, alias, routing = asyncio.run(gw_router._resolve_provider_and_model_with_policy(
        req=req, identity={"task_tag": "agent_turn", "stage": None, "purpose": None},
    ))
    assert (provider, model, alias) == ("anthropic", "claude-sonnet-4-6", "pinned")
    assert routing is None  # no routing block at all, not an empty one


def test_the_routing_block_is_absent_on_responses_by_default():
    from llm_gateway_service.app.types import ChatCompletionResponse, EmbeddingsResponse

    chat = ChatCompletionResponse(content="hi", finish_reason="stop", provider="mock", model="m")
    assert chat.routing is None
    embed = EmbeddingsResponse(embeddings=[[0.0]], dim=1, provider="mock", model="m")
    assert embed.routing is None


# ── degraded config ─────────────────────────────────────────────────────────
def test_a_missing_policy_file_degrades_with_a_warning(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "llm_policy_path", str(tmp_path / "nope.json"))
    model_policy.reset_cache_for_tests()
    assert model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY) is None
    assert any("not found" in w for w in model_policy.warnings())


def test_a_malformed_policy_file_degrades_with_a_warning(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, "{ this is not json")
    assert model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY) is None
    assert any("parse error" in w for w in model_policy.warnings())


def test_a_policy_that_is_not_an_object_degrades(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, ["not", "an", "object"])
    assert model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY) is None
    assert any("must be a JSON object" in w for w in model_policy.warnings())


def test_one_bad_route_does_not_discard_the_good_ones(monkeypatch, tmp_path):
    # Mirrors _sanitize_catalog: per-entry warnings, keep going. An operator's
    # typo in rule 1 must not silently disable rule 2.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [
            "not a route",
            {"when": {"task_tag": "judge"}, "tier": "no_such_tier"},
            {"when": {"task_tag": "judge"}, "tier": "cheap"},
        ],
    })
    assert model_policy.resolve(task_tag="judge", is_ready=ALL_READY).tier == "cheap"
    assert len(model_policy.warnings()) >= 2


def test_a_tier_written_as_a_bare_string_still_works_but_warns(monkeypatch, tmp_path):
    # Accepted rather than dropped, because dropping the tier routes nowhere —
    # but a one-entry tier has no readiness fallback, which is worth saying.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1, "tiers": {"cheap": "claude-haiku-4-5-20251001"}, "defaultTier": "cheap",
    })
    assert model_policy.resolve(is_ready=ALL_READY).alias == "claude-haiku-4-5-20251001"
    assert any("one-entry list" in w for w in model_policy.warnings())


def test_a_default_tier_pointing_at_nothing_is_ignored(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "ghost"})
    assert model_policy.resolve(task_tag="judge", is_ready=ALL_READY) is None
    assert any("ghost" in w for w in model_policy.warnings())


def test_an_empty_policy_has_no_opinion(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {"version": 1})
    assert model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY) is None


def test_the_shipped_example_policy_parses_without_warnings(monkeypatch):
    """The operator-facing example must actually load.

    An example that has drifted from the parser is worse than no example: it is
    the file people copy, so a stale one ships a broken policy into production
    with an operator's full confidence behind it.
    """
    import pathlib

    example = pathlib.Path(__file__).resolve().parents[2] / ".singularity" / "llm-policy.json.default"
    assert example.exists(), f"shipped example policy is missing at {example}"
    monkeypatch.setattr(settings, "llm_policy_path", str(example))
    model_policy.reset_cache_for_tests()

    described = model_policy.describe()
    assert model_policy.warnings() == []
    assert described["default_tier"] == "standard"
    assert set(described["tiers"]) == {"cheap", "standard", "deep"}
    assert described["route_count"] == 11
    # And it routes: the stage-specific agent_turn rule must beat the broad one.
    assert model_policy.resolve(task_tag="agent_turn", stage="develop", is_ready=ALL_READY).tier == "deep"

    # The three stages migrated out of WORKBENCH_DEFAULT_STAGE_MODEL_ALIASES.
    # Asserted by NAME rather than by route_count, because the thing that must
    # not regress is the RULE — code-heavy stages get a stronger model than the
    # agent_turn default — and a count check would still pass if someone deleted
    # `design` and added something unrelated.
    for stage in ("design", "develop", "fix"):
        decision = model_policy.resolve(task_tag="agent_turn", stage=stage, is_ready=ALL_READY)
        assert decision.tier == "deep", f"stage {stage} lost its stronger-model rule"
    # …and the relationship is what matters: an unlisted stage stays on the
    # broad agent_turn rule, one tier below.
    assert model_policy.resolve(task_tag="agent_turn", stage="review", is_ready=ALL_READY).tier == "standard"
    assert model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY).tier == "standard"

    # Tier entries are CATALOG IDS, not raw provider model names — a distinction
    # that is easy to get wrong because the two happen to coincide for some
    # entries. An alias that resolves to nothing is invisible until the readiness
    # walk falls off the end of the tier at request time.
    catalog = json.loads(
        (example.parent / "llm-models.json.default").read_text()
    )
    known = {entry.get("id") for entry in catalog}
    referenced = {alias for tier in described["tiers"].values() for alias in tier}
    assert referenced <= known, f"policy references unknown catalog aliases: {referenced - known}"

    # Every route tier must also point at a task_tag the platform actually emits,
    # or the rule is decoration.
    from llm_gateway_service.app import task_tags

    policy_tags = {
        route["when"]["task_tag"]
        for route in model_policy._load_policy()["routes"]
        if "task_tag" in route["when"]
    }
    assert policy_tags <= task_tags.KNOWN_TASK_TAGS, (
        f"policy routes on unknown task tags: {policy_tags - task_tags.KNOWN_TASK_TAGS}"
    )


def test_describe_reports_what_is_loaded(monkeypatch, tmp_path):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "judge"}, "tier": "cheap"}],
        "escalateWhenInputTokensExceed": {"cheap": 60000},
    })
    described = model_policy.describe()
    assert described["enabled"] is True
    assert described["default_tier"] == "standard"
    assert described["route_count"] == 1
    assert described["escalate_when_input_tokens_exceed"] == {"cheap": 60000}


# ── the audit line ──────────────────────────────────────────────────────────
def test_every_decision_carries_a_one_line_reason(monkeypatch, tmp_path):
    # A routing layer nobody can read back is one nobody will trust with the
    # production default, so it would sit switched off forever.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "world_model_distill"}, "tier": "cheap"}],
        "escalateWhenInputTokensExceed": {"cheap": 60000},
    })
    decision = model_policy.resolve(
        task_tag="world_model_distill", estimated_input_tokens=99_999,
        is_ready=lambda alias: alias == "claude-sonnet-4-6",
    )
    block = decision.as_dict()
    assert set(block) == {"source", "tier", "alias", "reason", "escalated_from"}
    assert "\n" not in block["reason"]
    # The line has to answer: what matched, why it moved, what it chose.
    assert "task_tag=world_model_distill" in block["reason"]
    assert "escalated cheap -> standard" in block["reason"]
    assert "chose claude-sonnet-4-6" in block["reason"]


# ── POST /llm/route/preview ─────────────────────────────────────────────────
@pytest.fixture
def _mock_catalog(monkeypatch, tmp_path):
    """A mock-only gateway: no credentials needed, so readiness is real."""
    catalog = tmp_path / "llm-models.json"
    catalog.write_text(json.dumps([
        {"id": "claude-haiku-4-5-20251001", "provider": "mock", "model": "mock-fast"},
        {"id": "claude-sonnet-4-6", "provider": "mock", "model": "mock-standard"},
        {"id": "claude-opus-4-1", "provider": "mock", "model": "mock-deep"},
    ]))
    monkeypatch.setattr(settings, "model_catalog_path", str(catalog))
    monkeypatch.setattr(settings, "provider_config_path", str(tmp_path / "absent.json"))
    provider_config.reset_cache_for_tests()
    yield
    provider_config.reset_cache_for_tests()


def _preview(**kw):
    from llm_gateway_service.app.router import preview_route
    from llm_gateway_service.app.types import RoutePreviewRequest

    # Resolution became async when budget degradation started reading spend
    # state over HTTP. asyncio.run keeps these tests synchronous, matching
    # the convention in test_direct_llm_client.py.
    return asyncio.run(preview_route(RoutePreviewRequest(**kw), authorization=None))


def test_preview_returns_the_model_without_calling_a_provider(monkeypatch, tmp_path, _mock_catalog):
    # CF needs the model BEFORE the call — its token-budget preflight has to know
    # the context window it is packing for. Without this, a policy-routed caller
    # could only learn its model by spending a provider call to find out.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "routes": [{"when": {"task_tag": "world_model_distill"}, "tier": "cheap"}],
    })
    result = _preview(task_tag="world_model_distill")
    assert result.ready is True
    assert result.model_alias == "claude-haiku-4-5-20251001"
    assert result.model == "mock-fast"
    assert result.policy_enabled is True
    assert result.routing["tier"] == "cheap"


def test_preview_agrees_with_the_real_resolution_path(monkeypatch, tmp_path, _mock_catalog):
    # Preview runs the SAME function the endpoints run. Duplicating the logic
    # would give a preview that agrees with the call right up until the day it
    # quietly stops.
    from llm_gateway_service.app import router as gw_router
    from types import SimpleNamespace

    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "deep",
        "routes": [{"when": {"task_tag": "agent_turn", "stage": "develop"}, "tier": "deep"}],
    })
    identity = {"task_tag": "agent_turn", "stage": "develop", "purpose": None}
    req = SimpleNamespace(model_alias=None, provider=None, model=None,
                          expected_model=None, model_tier=None, messages=[])
    provider, model, alias, routing = asyncio.run(gw_router._resolve_provider_and_model_with_policy(
        req=req, identity=identity,
    ))
    preview = _preview(task_tag="agent_turn", stage="develop")
    assert (preview.provider, preview.model, preview.model_alias) == (provider, model, alias)
    assert preview.routing == routing


def test_preview_estimates_size_from_messages(monkeypatch, tmp_path, _mock_catalog):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "cheap",
        "escalateWhenInputTokensExceed": {"cheap": 100},
    })
    small = _preview(messages=[{"role": "user", "content": "a" * 40}])
    assert small.estimated_input_tokens == 10
    assert small.routing["tier"] == "cheap"

    large = _preview(messages=[{"role": "user", "content": "a" * 4000}])
    assert large.estimated_input_tokens == 1000
    assert large.routing["tier"] == "standard"
    assert large.routing["escalated_from"] == "cheap"


def test_preview_accepts_a_size_without_messages(monkeypatch, tmp_path, _mock_catalog):
    # A caller previewing a request it has not assembled yet still gets a real
    # answer, and naming a huge token count costs the gateway nothing.
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "cheap",
        "escalateWhenInputTokensExceed": {"cheap": 60000},
    })
    result = _preview(estimated_input_tokens=50_000_000)
    assert result.estimated_input_tokens == 50_000_000
    assert result.routing["tier"] == "standard"


def test_preview_reports_a_failure_instead_of_raising_one(monkeypatch, tmp_path, _mock_catalog):
    # A preflight whose job is to report what WOULD happen should report "this
    # would fail", not itself fail — otherwise the caller cannot tell a broken
    # preflight from a broken route.
    _write_policy(monkeypatch, tmp_path, {"version": 1, "tiers": BASE_TIERS, "defaultTier": "standard"})
    result = _preview(model_alias="no-such-alias")
    assert result.ready is False
    assert "unknown model alias" in result.error
    assert result.model is None


def test_preview_honours_a_caller_pin(monkeypatch, tmp_path, _mock_catalog):
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "deep",
        "routes": [{"when": {"task_tag": "agent_turn"}, "tier": "deep"}],
    })
    result = _preview(model_alias="claude-haiku-4-5-20251001", task_tag="agent_turn")
    assert result.model_alias == "claude-haiku-4-5-20251001"
    assert result.routing["source"] == "caller_pin"


def test_preview_works_with_policy_disabled(monkeypatch, tmp_path, _mock_catalog):
    # The endpoint is useful before the engine is switched on: it still answers
    # "which model would this call get", which is today the implicit default.
    monkeypatch.delenv("GATEWAY_MODEL_POLICY_ENABLED", raising=False)
    monkeypatch.delenv("GATEWAY_STRICT_DEFAULT_ALIAS", raising=False)
    result = _preview(task_tag="agent_turn")
    assert result.policy_enabled is False
    assert result.routing is None
    assert result.model_alias == "claude-haiku-4-5-20251001"  # today's implicit default


def test_embeddings_route_by_tier_but_never_escalate_by_size(monkeypatch, tmp_path, _mock_catalog):
    """An EmbeddingsRequest carries `input`, not `messages`, so the size estimate
    is 0 and embeddings never escalate. That is correct, not an oversight:
    routing a long input to a "deeper" embedding model writes vectors from a
    second model into the same index — the silent corruption the expected_model
    drift guard exists to catch. Tier routing still applies.
    """
    from llm_gateway_service.app import router as gw_router
    from llm_gateway_service.app.types import EmbeddingsRequest

    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "cheap",
        "escalateWhenInputTokensExceed": {"cheap": 10},
    })
    req = EmbeddingsRequest(input=["x" * 100_000], task_tag="embedding")
    _, _, alias, routing = asyncio.run(gw_router._resolve_provider_and_model_with_policy(
        req=req, identity={"task_tag": "embedding", "stage": None, "purpose": None},
    ))
    assert routing["tier"] == "cheap"
    assert "escalated_from" not in routing
    assert alias == "claude-haiku-4-5-20251001"


def test_preview_and_policy_routes_are_registered_on_the_app():
    from llm_gateway_service.app.main import app

    paths = {route.path for route in app.routes}
    assert "/llm/route/preview" in paths
    assert "/llm/policy" in paths


# ── provider_config: the silent default-alias fallback ──────────────────────
@pytest.fixture
def _catalog(monkeypatch, tmp_path):
    def _install(entries):
        path = tmp_path / "llm-models.json"
        path.write_text(json.dumps(entries))
        monkeypatch.setattr(settings, "model_catalog_path", str(path))
        provider_config.reset_cache_for_tests()
    yield _install
    provider_config.reset_cache_for_tests()


def test_a_marked_default_is_returned_without_complaint(_catalog, monkeypatch):
    monkeypatch.delenv("GATEWAY_STRICT_DEFAULT_ALIAS", raising=False)
    _catalog([
        {"id": "fast", "provider": "mock", "model": "mock-fast"},
        {"id": "smart", "provider": "mock", "model": "mock-smart", "default": True},
    ])
    assert provider_config.default_model_alias() == "smart"
    assert provider_config.warnings() == []


def test_an_unmarked_catalog_still_falls_back_but_says_so(_catalog, monkeypatch):
    # The fallback is preserved — removing it would break every deployment with
    # an unmarked catalog — but catalog ORDER silently deciding the platform
    # default is exactly the thing that must not happen quietly. A UI reorder or
    # a DELETE /llm/models repointed every untargeted call with no log line.
    monkeypatch.delenv("GATEWAY_STRICT_DEFAULT_ALIAS", raising=False)
    _catalog([
        {"id": "fast", "provider": "mock", "model": "mock-fast"},
        {"id": "smart", "provider": "mock", "model": "mock-smart"},
    ])
    assert provider_config.default_model_alias() == "fast"
    assert any("falling back to the first entry (fast)" in w for w in provider_config.warnings())


def test_the_warning_is_emitted_once_not_per_request(_catalog, monkeypatch):
    # default_model_alias() runs on the hot path for every untargeted call; a
    # per-request line would bury the signal it exists to raise.
    monkeypatch.delenv("GATEWAY_STRICT_DEFAULT_ALIAS", raising=False)
    _catalog([{"id": "fast", "provider": "mock", "model": "mock-fast"}])
    for _ in range(5):
        provider_config.default_model_alias()
    assert len(provider_config.warnings()) == 1


def test_strict_mode_refuses_the_implicit_default(_catalog, monkeypatch):
    monkeypatch.setenv("GATEWAY_STRICT_DEFAULT_ALIAS", "true")
    _catalog([
        {"id": "fast", "provider": "mock", "model": "mock-fast"},
        {"id": "smart", "provider": "mock", "model": "mock-smart"},
    ])
    assert provider_config.default_model_alias() is None
    assert any("refusing the implicit fallback" in w for w in provider_config.warnings())


def test_strict_mode_still_honours_an_explicit_default(_catalog, monkeypatch):
    # Strict is about the IMPLICIT fallback only; a properly-marked catalog is
    # unaffected, so the flag is safe to turn on ahead of a catalog fix.
    monkeypatch.setenv("GATEWAY_STRICT_DEFAULT_ALIAS", "true")
    _catalog([
        {"id": "fast", "provider": "mock", "model": "mock-fast"},
        {"id": "smart", "provider": "mock", "model": "mock-smart", "default": True},
    ])
    assert provider_config.default_model_alias() == "smart"


def test_an_empty_catalog_has_no_default_in_either_mode(_catalog, monkeypatch):
    _catalog([])
    monkeypatch.delenv("GATEWAY_STRICT_DEFAULT_ALIAS", raising=False)
    assert provider_config.default_model_alias() is None
    monkeypatch.setenv("GATEWAY_STRICT_DEFAULT_ALIAS", "1")
    assert provider_config.default_model_alias() is None


# ── B3: budget-aware degradation ────────────────────────────────────────────
#
# Degradation is the most dangerous feature in this engine, because its failure
# mode is invisible: the model still answers, the answer is just worse. Every
# test below is therefore about a case where degradation must NOT happen, or
# about the evidence it leaves behind when it does.
from llm_gateway_service.app import budget_state  # noqa: E402


@pytest.fixture
def _degradation_on(monkeypatch):
    monkeypatch.setenv("GATEWAY_BUDGET_DEGRADATION_ENABLED", "true")
    budget_state.reset_cache_for_tests()
    yield
    budget_state.reset_cache_for_tests()


BUDGET_POLICY = {
    "version": 1,
    "tiers": BASE_TIERS,
    "defaultTier": "deep",
    "routes": [{"when": {"task_tag": "judge"}, "tier": "deep"}],
    "budget": {
        "degradeAtPercent": 90,
        "floors": {"judge": "deep"},
        "optOut": ["claim_lowering"],
    },
}


def test_budget_pressure_degrades_exactly_one_rung(monkeypatch, tmp_path, _degradation_on):
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY,
        budget_used_fraction=0.95, budget_note="tenant=acme at 95% of budget",
    )
    # deep -> standard. NOT deep -> cheap: one rung, like escalation, because
    # this is a guard rail and not a second routing system.
    assert decision.tier == "standard"
    assert decision.degraded_from == "deep"
    assert "95%" in decision.degrade_reason
    assert "tenant=acme" in decision.degrade_reason


def test_degradation_is_absent_from_the_routing_block_when_it_did_not_happen(monkeypatch, tmp_path, _degradation_on):
    """The field's PRESENCE is the signal. A routing block that always carries
    degraded_from=None makes "did we degrade anything" a value check instead of
    an existence check, and value checks are what people forget to write."""
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=0.10)
    assert decision.degraded_from is None
    assert "degraded_from" not in decision.as_dict()
    assert "degrade_reason" not in decision.as_dict()


def test_a_degradation_lands_in_the_routing_block(monkeypatch, tmp_path, _degradation_on):
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    block = model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=0.99,
    ).as_dict()
    assert block["degraded_from"] == "deep"
    assert block["tier"] == "standard"
    assert block["degrade_reason"]


def test_the_flag_off_means_no_degradation_however_high_the_spend(monkeypatch, tmp_path):
    """Ships off. An operator must be able to turn this off and have routing
    return to exactly what the policy file says, with no restart."""
    monkeypatch.delenv("GATEWAY_BUDGET_DEGRADATION_ENABLED", raising=False)
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=1.5)
    assert decision.tier == "deep"
    assert decision.degraded_from is None


def test_no_budget_signal_means_no_degradation(monkeypatch, tmp_path, _degradation_on):
    """None is not zero. An audit-gov outage must not quietly move the whole
    platform onto cheaper models — that is a quality incident caused by a
    monitoring dependency, which is strictly worse than not degrading."""
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=None)
    assert decision.tier == "deep"
    assert decision.degraded_from is None


def test_below_threshold_does_not_degrade(monkeypatch, tmp_path, _degradation_on):
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    assert model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=0.899,
    ).degraded_from is None
    # ...and the boundary is inclusive, so 90% of a 90% threshold degrades.
    assert model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=0.90,
    ).degraded_from == "deep"


def test_a_floor_is_never_breached(monkeypatch, tmp_path, _degradation_on):
    """The whole point of a floor. A judge demoted to a cheap model still
    returns a confident score, and a confidently wrong grade is worse than no
    grade at all."""
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(
        task_tag="judge", is_ready=ALL_READY, budget_used_fraction=1.0,
    )
    assert decision.tier == "deep"          # floor: deep — cannot move at all
    assert decision.degraded_from is None


def test_a_floor_below_the_current_tier_still_allows_one_step(monkeypatch, tmp_path, _degradation_on):
    policy = json.loads(json.dumps(BUDGET_POLICY))
    policy["budget"]["floors"] = {"agent_turn": "standard"}
    _write_policy(monkeypatch, tmp_path, policy)
    decision = model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=1.0)
    assert decision.tier == "standard"      # deep -> standard is allowed
    assert decision.degraded_from == "deep"
    # ...and a second call from standard cannot go below the floor to cheap.
    policy["defaultTier"] = "standard"
    policy["routes"] = []
    _write_policy(monkeypatch, tmp_path, policy)
    assert model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=1.0,
    ).degraded_from is None


def test_opt_out_is_never_degraded(monkeypatch, tmp_path, _degradation_on):
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(
        task_tag="claim_lowering", is_ready=ALL_READY, budget_used_fraction=1.0,
    )
    assert decision.degraded_from is None


def test_a_floor_naming_an_undefined_tier_opts_the_tag_OUT(monkeypatch, tmp_path, _degradation_on):
    """Fail toward NOT degrading.

    Dropping a malformed floor would make degradation MORE aggressive for
    exactly the tag an operator was trying to protect. A typo in a floor must
    not be the reason a judge ends up on a cheap model.
    """
    policy = json.loads(json.dumps(BUDGET_POLICY))
    policy["budget"]["floors"] = {"judge": "premuim"}   # sic
    _write_policy(monkeypatch, tmp_path, policy)
    decision = model_policy.resolve(task_tag="judge", is_ready=ALL_READY, budget_used_fraction=1.0)
    assert decision.degraded_from is None
    assert any("premuim" in w for w in model_policy.warnings())


def test_the_cheapest_tier_has_nowhere_to_degrade_to(monkeypatch, tmp_path, _degradation_on):
    policy = json.loads(json.dumps(BUDGET_POLICY))
    policy["defaultTier"] = "cheap"
    policy["routes"] = []
    _write_policy(monkeypatch, tmp_path, policy)
    decision = model_policy.resolve(task_tag="agent_turn", is_ready=ALL_READY, budget_used_fraction=1.0)
    assert decision.tier == "cheap"
    assert decision.degraded_from is None


def test_a_caller_pin_is_not_degraded(monkeypatch, tmp_path, _degradation_on):
    """An explicit model_alias skips policy entirely, so budget pressure cannot
    silently override an operator who named a model."""
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    decision = model_policy.resolve(
        model_alias="pinned", is_ready=ALL_READY, budget_used_fraction=1.0,
    )
    assert decision.source == "caller_pin"
    assert decision.degraded_from is None


def test_size_escalation_wins_over_budget_degradation(monkeypatch, tmp_path, _degradation_on):
    """Escalation is correctness; degradation is a cost preference.

    Both move exactly one rung, in opposite directions, so applying both to one
    call nets to NO CHANGE — the engine would escalate a 200k-token request to a
    tier that can hold it and hand it straight back to the tier that cannot.
    That is not a cheaper answer, it is a failed one that still costs money, and
    it fails only on the large requests nobody tests with.

    Worse, the audit trail would show BOTH an escalated_from and a degraded_from
    on a call whose tier never moved, which is the most misleading thing this
    engine could write down.
    """
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "cheap",
        "escalateWhenInputTokensExceed": {"cheap": 1000},
        "budget": {"degradeAtPercent": 50},
    })
    decision = model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY,
        estimated_input_tokens=50_000, budget_used_fraction=1.0,
    )
    assert decision.escalated_from == "cheap"
    assert decision.tier == "standard"       # the size escalation STANDS
    assert decision.degraded_from is None    # budget did not claw it back


def test_a_call_that_did_not_escalate_still_degrades(monkeypatch, tmp_path, _degradation_on):
    """The escalation guard must not become a blanket off-switch: only calls
    that ACTUALLY escalated are protected."""
    _write_policy(monkeypatch, tmp_path, {
        "version": 1,
        "tiers": BASE_TIERS,
        "defaultTier": "standard",
        "escalateWhenInputTokensExceed": {"standard": 150_000},
        "budget": {"degradeAtPercent": 50},
    })
    decision = model_policy.resolve(
        task_tag="agent_turn", is_ready=ALL_READY,
        estimated_input_tokens=10, budget_used_fraction=1.0,
    )
    assert decision.escalated_from is None
    assert decision.degraded_from == "standard"
    assert decision.tier == "cheap"


def test_describe_surfaces_what_is_protected(monkeypatch, tmp_path, _degradation_on):
    """An operator must be able to answer "what is protected from degradation"
    from an endpoint, not by reading the policy file off a container's disk."""
    _write_policy(monkeypatch, tmp_path, BUDGET_POLICY)
    described = model_policy.describe()["budget"]
    assert described["degradation_enabled"] is True
    assert described["degrade_at_percent"] == 90
    assert described["floors"] == {"judge": "deep"}
    assert described["opt_out"] == ["claim_lowering"]


def test_the_shipped_example_policy_protects_the_judge():
    """The judge and the canonicalizer are the two jobs whose output is trusted
    downstream without a human reading it. If the shipped example ever stops
    protecting them, that is a silent quality hole by default."""
    import pathlib

    example = pathlib.Path(__file__).resolve().parents[2] / ".singularity" / "llm-policy.json.default"
    shipped = json.loads(example.read_text())
    budget = shipped["budget"]
    assert "judge" in budget["floors"] or "judge" in budget["optOut"]
    assert "claim_lowering" in budget["floors"] or "claim_lowering" in budget["optOut"]


# ── the spend signal itself ─────────────────────────────────────────────────
def test_budget_state_reports_the_worst_utilisation_across_periods():
    """A scope can carry day/week/month budgets at once. The binding constraint
    is whichever is closest to its cap; averaging would let a fresh monthly
    budget mask an exhausted daily one."""
    fraction = budget_state._used_fraction_from_rows([
        {"current_tokens": 10, "tokens_max": 100},      # 10%
        {"current_cost": 95, "cost_max_usd": 100},      # 95%  <- binding
    ])
    assert fraction == pytest.approx(0.95)


def test_budget_state_ignores_rows_with_no_cap():
    """A budget row with no maximum is a spend RECORD, not a limit. Treating it
    as 100% used would degrade every caller who merely has cost tracking on."""
    assert budget_state._used_fraction_from_rows([{"current_tokens": 999}]) is None
    assert budget_state._used_fraction_from_rows([{"current_tokens": 999, "tokens_max": 0}]) is None
    assert budget_state._used_fraction_from_rows([]) is None
    assert budget_state._used_fraction_from_rows("not a list") is None


def test_budget_state_survives_junk_rows():
    fraction = budget_state._used_fraction_from_rows([
        "nonsense",
        {"current_tokens": "abc", "tokens_max": "def"},
        {"current_cost": 50, "cost_max_usd": 100},
    ])
    assert fraction == pytest.approx(0.5)
