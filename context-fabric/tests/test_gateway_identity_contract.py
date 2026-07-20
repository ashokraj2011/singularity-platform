"""
Caller identity and the embeddings drift guard at the LLM gateway.

`task_tag` answered "what kind of work is this". These fields answer "on whose
behalf" — without which "what did this user's LLM traffic cost today" was not a
hard query but an impossible one: no LLM record anywhere in the platform carried
an actor.

Everything here is additive and optional, so this changes no behaviour on its
own. What is pinned:

  - the identity fields exist on BOTH request shapes, because embeddings are the
    highest-volume traffic and omitting them there would leave the biggest cost
    line unattributable
  - embeddings gained expected_provider / expected_model. The omission mattered
    more here than on chat: a silently-changed chat model gives one visibly-off
    answer, a silently-changed embedding model corrupts a vector index
  - embedding cost uses a function that needs only an INPUT price. Reusing
    compute_estimated_cost would have looked correct and returned None for every
    realistically-configured embedding model, since embeddings have no output
    and a catalog author has every reason to omit outputPricePerMtok
"""
from __future__ import annotations

import pytest

from llm_gateway_service.app import provider_config
from llm_gateway_service.app.types import (
    ChatCompletionRequest,
    EmbeddingsRequest,
    EmbeddingsResponse,
)


def test_chat_request_carries_caller_identity():
    req = ChatCompletionRequest(
        messages=[{"role": "user", "content": "hi"}],
        actor_id="user:ashok",
        tenant_id="acme",
        session_id="sy:thread:abc",
    )
    assert req.actor_id == "user:ashok"
    assert req.tenant_id == "acme"
    assert req.session_id == "sy:thread:abc"


def test_identity_is_optional_so_no_existing_caller_breaks():
    req = ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}])
    assert req.actor_id is None
    assert req.tenant_id is None
    assert req.session_id is None
    assert req.model_tier is None


def test_embeddings_request_carries_the_same_identity():
    # The highest-volume endpoint. Identity here or the largest cost line in the
    # platform stays anonymous.
    req = EmbeddingsRequest(input=["a"], actor_id="system:agent-runtime", tenant_id="acme")
    assert req.actor_id == "system:agent-runtime"
    assert req.tenant_id == "acme"


def test_embeddings_request_has_a_drift_guard():
    req = EmbeddingsRequest(input=["a"], expected_provider="openai", expected_model="text-embedding-3-small")
    assert req.expected_provider == "openai"
    assert req.expected_model == "text-embedding-3-small"


def test_model_tier_is_distinct_from_model_alias():
    # A pin skips policy entirely; a tier asks policy to choose within a class.
    # Collapsing them would make "let the platform decide" unexpressible.
    req = ChatCompletionRequest(messages=[{"role": "user", "content": "x"}], model_tier="deep")
    assert req.model_tier == "deep"
    assert req.model_alias is None


def test_embeddings_response_can_carry_cost():
    resp = EmbeddingsResponse(
        embeddings=[[0.0]], dim=1, provider="mock", model="mock-embed",
        input_tokens=10, estimated_cost=0.0,
    )
    assert resp.estimated_cost == 0.0


def test_embeddings_response_cost_is_optional():
    resp = EmbeddingsResponse(embeddings=[[0.0]], dim=1, provider="mock", model="mock-embed")
    assert resp.estimated_cost is None


class _Catalog:
    """Swaps the catalog for one entry, so these assert arithmetic not config."""

    def __init__(self, monkeypatch, entry):
        monkeypatch.setattr(provider_config, "resolve_alias", lambda alias: entry)


def test_embedding_cost_needs_only_an_input_price(monkeypatch):
    # THE point of the separate function. An embedding model produces no output,
    # so outputPricePerMtok is legitimately absent. compute_estimated_cost
    # requires both and would return None here — a cost path that looks wired
    # and silently reports nothing.
    _Catalog(monkeypatch, {"id": "e", "inputPricePerMtok": 20.0})
    assert provider_config.compute_embedding_cost("e", 1_000_000) == 20.0
    assert provider_config.compute_estimated_cost("e", 1_000_000, 0) is None


def test_embedding_cost_is_none_without_an_input_price(monkeypatch):
    # No fake $0.00: unpriced must stay visibly unpriced.
    _Catalog(monkeypatch, {"id": "e"})
    assert provider_config.compute_embedding_cost("e", 1000) is None


def test_embedding_cost_ignores_output_price(monkeypatch):
    # An embedding call has no output tokens; a stray output price in the
    # catalog must not inflate the number.
    _Catalog(monkeypatch, {"id": "e", "inputPricePerMtok": 10.0, "outputPricePerMtok": 999.0})
    assert provider_config.compute_embedding_cost("e", 1_000_000) == 10.0


def test_embedding_cost_without_alias_is_none():
    assert provider_config.compute_embedding_cost(None, 1000) is None


def test_embedding_cost_survives_an_unknown_alias(monkeypatch):
    # Costing must never be the reason a call fails.
    def _raise(alias):
        raise provider_config.ProviderConfigError("unknown model alias: nope")

    monkeypatch.setattr(provider_config, "resolve_alias", _raise)
    assert provider_config.compute_embedding_cost("nope", 1000) is None


def test_router_guards_embeddings_against_drift():
    # Source-level, because exercising the handler needs a live provider. The
    # 409 must sit AFTER resolution (it compares the resolved model) and BEFORE
    # any provider call, so drift costs nothing upstream.
    import pathlib

    src = pathlib.Path(provider_config.__file__).with_name("router.py").read_text()
    embeddings_handler = src[src.index('@router.post("/v1/embeddings"'):]
    resolve_at = embeddings_handler.index("_resolve_provider_and_model")
    guard_at = embeddings_handler.index("does not match expected provider")
    call_at = embeddings_handler.index("mock_provider.embed")
    assert resolve_at < guard_at < call_at
