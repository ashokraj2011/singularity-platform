"""
Task identity at the LLM gateway.

The requirement is that every LLM call reaches a gateway *tagged for its task*.
Before this, the gateway knew which model was asked for and nothing about why —
task identity lived inside context-fabric and never crossed the hop.

What is pinned here:
  - a tag is normalised, so "World-Model Distill" and "world_model_distill"
    aggregate together instead of splitting a cost line in two
  - an UNKNOWN tag warns but passes; blocking a new caller at the hop would be
    worse than logging one it does not recognise yet
  - an ABSENT tag warns today and 400s once GATEWAY_REQUIRE_TASK_TAG is set,
    so callers migrate without an outage
  - audit emission never raises: a logging failure must not fail the call it
    is describing
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from llm_gateway_service.app import task_tags


def _req(**kw):
    base = {
        "task_tag": None,
        "stage": None,
        "purpose": None,
        "model_alias": "fast",
        "capability_id": "cap-1",
        "trace_id": "trace-1",
        "run_id": "run-1",
    }
    base.update(kw)
    return SimpleNamespace(**base)


# ── normalisation ────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("agent_turn", "agent_turn"),
        ("Agent_Turn", "agent_turn"),
        ("world-model-distill", "world_model_distill"),
        ("  claim lowering  ", "claim_lowering"),
        ("", None),
        ("   ", None),
        (None, None),
        (42, None),
    ],
)
def test_tags_normalise(raw, expected):
    assert task_tags.normalize_task_tag(raw) == expected


def test_every_known_tag_is_already_normal_form():
    """A vocabulary entry that does not survive its own normaliser would never
    match a caller sending it back."""
    for tag in task_tags.KNOWN_TASK_TAGS:
        assert task_tags.normalize_task_tag(tag) == tag


# ── resolution ───────────────────────────────────────────────────────────────
def test_known_tag_resolves_quietly(caplog):
    with caplog.at_level(logging.WARNING, logger="llm_gateway.task"):
        identity = task_tags.resolve_task_identity(
            _req(task_tag="agent_turn", stage="Develop", purpose="code-edit"),
            endpoint="chat_completions",
        )
    assert identity == {"task_tag": "agent_turn", "stage": "develop", "purpose": "code_edit"}
    assert caplog.records == []


def test_unknown_tag_warns_but_passes_through(caplog):
    """A new caller naming a genuinely new bucket should be VISIBLE, not blocked."""
    with caplog.at_level(logging.WARNING, logger="llm_gateway.task"):
        identity = task_tags.resolve_task_identity(_req(task_tag="brand_new_thing"), endpoint="chat_completions")
    assert identity["task_tag"] == "brand_new_thing"
    assert any("unknown_task_tag" in r.getMessage() for r in caplog.records)


def test_missing_tag_warns_when_not_required(monkeypatch, caplog):
    monkeypatch.delenv("GATEWAY_REQUIRE_TASK_TAG", raising=False)
    with caplog.at_level(logging.WARNING, logger="llm_gateway.task"):
        identity = task_tags.resolve_task_identity(_req(), endpoint="chat_completions")
    assert identity["task_tag"] is None
    assert any("untagged_call" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes", "on"])
def test_missing_tag_is_rejected_once_required(monkeypatch, flag):
    monkeypatch.setenv("GATEWAY_REQUIRE_TASK_TAG", flag)
    with pytest.raises(HTTPException) as exc:
        task_tags.resolve_task_identity(_req(), endpoint="chat_completions")
    assert exc.value.status_code == 400
    assert "task_tag is required" in str(exc.value.detail)


def test_requirement_flag_is_read_per_call(monkeypatch):
    """Read at call time, not import time, so an operator can flip it without a
    restart — and so the rollout can be reverted instantly if it bites."""
    monkeypatch.setenv("GATEWAY_REQUIRE_TASK_TAG", "true")
    assert task_tags.require_task_tag() is True
    monkeypatch.setenv("GATEWAY_REQUIRE_TASK_TAG", "false")
    assert task_tags.require_task_tag() is False


def test_a_tagged_call_is_never_rejected_even_when_required(monkeypatch):
    monkeypatch.setenv("GATEWAY_REQUIRE_TASK_TAG", "true")
    identity = task_tags.resolve_task_identity(_req(task_tag="embedding"), endpoint="chat_completions")
    assert identity["task_tag"] == "embedding"


def test_embeddings_self_identify(monkeypatch):
    """There is exactly one reason to call the embeddings endpoint, so making
    callers say so adds friction without adding information — and it must not
    400 under the required flag either."""
    monkeypatch.setenv("GATEWAY_REQUIRE_TASK_TAG", "true")
    identity = task_tags.resolve_task_identity(_req(), endpoint="embeddings")
    assert identity["task_tag"] == "embedding"


def test_explicit_tag_beats_the_embeddings_default():
    identity = task_tags.resolve_task_identity(_req(task_tag="world_model_distill"), endpoint="embeddings")
    assert identity["task_tag"] == "world_model_distill"


# ── audit emission ───────────────────────────────────────────────────────────
def test_audit_line_carries_identity_and_cost(caplog):
    with caplog.at_level(logging.INFO, logger="llm_gateway.task"):
        task_tags.emit_call_audit(
            endpoint="chat_completions",
            identity={"task_tag": "agent_turn", "stage": "develop", "purpose": None},
            provider="anthropic",
            model="claude-x",
            model_alias="fast",
            req=_req(),
            input_tokens=100,
            output_tokens=50,
            estimated_cost=0.0123,
        )
    line = "\n".join(r.getMessage() for r in caplog.records)
    for fragment in [
        "llm_gateway.call",
        "task_tag=agent_turn",
        "stage=develop",
        "purpose=-",
        "provider=anthropic",
        "capability_id=cap-1",
        "trace_id=trace-1",
        "input_tokens=100",
        "estimated_cost=0.012300",
    ]:
        assert fragment in line


def test_audit_never_raises_on_a_hostile_request():
    """Emission must not fail the call it is describing."""

    class Explodes:
        def __getattr__(self, _name):
            raise RuntimeError("boom")

    task_tags.emit_call_audit(
        endpoint="chat_completions",
        identity={"task_tag": "agent_turn"},
        provider="anthropic",
        model="m",
        model_alias=None,
        req=Explodes(),
    )


def test_audit_tolerates_missing_token_counts(caplog):
    with caplog.at_level(logging.INFO, logger="llm_gateway.task"):
        task_tags.emit_call_audit(
            endpoint="embeddings",
            identity={"task_tag": "embedding", "stage": None, "purpose": None},
            provider="openai",
            model="text-embed",
            model_alias=None,
            req=_req(),
        )
    line = "\n".join(r.getMessage() for r in caplog.records)
    assert "output_tokens=-" in line and "estimated_cost=-" in line


# ── the vocabulary ───────────────────────────────────────────────────────────
def test_the_infra_callers_this_change_tags_are_in_the_vocabulary():
    """These are the tags actually sent by callers wired in this change; a
    vocabulary that omits one would warn on every real call."""
    for tag in ["agent_turn", "world_model_distill", "claim_lowering", "embedding"]:
        assert tag in task_tags.KNOWN_TASK_TAGS


# ── context-fabric's own governed calls ──────────────────────────────────────
def test_the_governed_loop_tags_its_gateway_calls():
    """The governed loop is the platform's highest-volume agent path, and it was
    reaching the gateway UNTAGGED -- so GATEWAY_REQUIRE_TASK_TAG would have 400'd
    every governed turn, and until then the biggest cost line was the one nobody
    could attribute. Pinned so the gap cannot silently reopen."""
    from context_api_service.app.governed.llm_client import _build_chat_body

    body = _build_chat_body(
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        model_alias="fast",
        expected_provider=None,
        expected_model=None,
        temperature=None,
        max_output_tokens=None,
        thinking_budget=None,
        prompt_cache=False,
        prompt_cache_key=None,
    )
    assert body["task_tag"] == "agent_turn"
    assert body["task_tag"] in task_tags.KNOWN_TASK_TAGS


def test_the_governed_loop_tag_can_be_overridden():
    from context_api_service.app.governed.llm_client import _build_chat_body

    body = _build_chat_body(
        messages=[{"role": "user", "content": "hi"}],
        tools=None, model_alias=None, expected_provider=None, expected_model=None,
        temperature=None, max_output_tokens=None, thinking_budget=None,
        prompt_cache=False, prompt_cache_key=None,
        task_tag="planning",
    )
    assert body["task_tag"] == "planning"


def test_the_governed_loop_sends_stage_and_purpose():
    """A tag alone cannot distinguish a design turn from a develop turn.

    Every governed turn is `agent_turn`, so a policy route keyed on
    {task_tag: agent_turn, stage: develop} was UNMATCHABLE until stage crossed
    the hop. That is not a cosmetic gap: it is the reason "code-heavy stages get
    a stronger model" had to be expressed as a per-stage alias map in the
    workbench, which is a policy file living in an env var.
    """
    from context_api_service.app.governed.llm_client import _build_chat_body

    body = _build_chat_body(
        messages=[{"role": "user", "content": "hi"}],
        tools=None, model_alias=None, expected_provider=None, expected_model=None,
        temperature=None, max_output_tokens=None, thinking_budget=None,
        prompt_cache=False, prompt_cache_key=None,
        stage="develop", purpose="implement",
    )
    assert body["task_tag"] == "agent_turn"
    assert body["stage"] == "develop"
    assert body["purpose"] == "implement"


def test_stage_and_purpose_are_omitted_when_unknown():
    """Absent must mean "the caller could not say", not "no stage".

    Sending stage="" would make the field always present and never useful — a
    route matching on it could not distinguish an untagged caller from a real
    empty stage, and normalize_task_tag would drop it anyway.
    """
    from context_api_service.app.governed.llm_client import _build_chat_body

    body = _build_chat_body(
        messages=[{"role": "user", "content": "hi"}],
        tools=None, model_alias=None, expected_provider=None, expected_model=None,
        temperature=None, max_output_tokens=None, thinking_budget=None,
        prompt_cache=False, prompt_cache_key=None,
    )
    assert "stage" not in body
    assert "purpose" not in body
