"""
gateway_call_id — the call identity the gateway mints and hands back.

Cost rows and trace events have been joined heuristically, by trace_id plus
timestamp proximity, because nothing minted a per-call identity. One trace can
contain many LLM calls, so "closest in time" is a guess that gets worse exactly
when it matters most: under load, on retries, on parallel fan-out.

The gateway is the only component that sees every call, so it is the only one
that can hand out that identity. It goes on the response (so CF can put it on
governed.llm_response) and on the cost event (where it is llm_calls' partial
unique index, making a retried emission a no-op rather than double-counted
spend).

These drive the REAL router through the mock provider, so they also pin the
thing unit tests cannot: that emission is wired into both endpoints, and that
with the flag off the endpoints behave exactly as they did before.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_gateway_service.app import audit_emit
from llm_gateway_service.app.router import router


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("GATEWAY_AUDIT_EMIT_ENABLED", raising=False)
    audit_emit.reset_for_tests()
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as c:
        yield c
    audit_emit.reset_for_tests()


@pytest.fixture
def captured(monkeypatch):
    """Capture what the router hands the emitter, without any HTTP."""
    calls: list[dict] = []
    monkeypatch.setattr(audit_emit, "emit_llm_call", lambda **kw: calls.append(kw))
    return calls


CHAT_BODY = {
    "provider": "mock",
    "model": "mock-fast",
    "messages": [{"role": "user", "content": "what is the capital of France"}],
    "task_tag": "agent_turn",
    "trace_id": "trace-abc",
    "capability_id": "cap-1",
    "tenant_id": "tenant-1",
    "actor_id": "user-7",
}

EMBED_BODY = {
    "provider": "mock",
    "model": "mock-embed",
    "input": ["a document chunk to embed"],
    "trace_id": "trace-def",
    "capability_id": "cap-2",
    "tenant_id": "tenant-1",
    "actor_id": "system:context-fabric",
}


@pytest.fixture(autouse=True)
def _allow_override(monkeypatch):
    # The bodies above pin provider/model directly so the tests do not depend on
    # whatever alias catalog happens to be mounted.
    from llm_gateway_service.app.config import settings
    monkeypatch.setattr(settings, "allow_caller_provider_override", True)


# ── minted and returned ─────────────────────────────────────────────────────
def test_chat_response_carries_a_uuid_call_id(client):
    res = client.post("/v1/chat/completions", json=CHAT_BODY)
    assert res.status_code == 200, res.text
    call_id = res.json()["gateway_call_id"]
    # Must actually be a UUID: llmCallPayload validates the shape, and audit-gov
    # stores it in a UUID column.
    assert uuid.UUID(call_id)


def test_embeddings_response_carries_a_uuid_call_id(client):
    res = client.post("/v1/embeddings", json=EMBED_BODY)
    assert res.status_code == 200, res.text
    assert uuid.UUID(res.json()["gateway_call_id"])


def test_every_call_gets_its_own_id(client):
    """The entire point. Two calls on ONE trace_id are exactly the case
    trace_id + timestamp cannot separate."""
    a = client.post("/v1/chat/completions", json=CHAT_BODY).json()["gateway_call_id"]
    b = client.post("/v1/chat/completions", json=CHAT_BODY).json()["gateway_call_id"]
    assert a != b


# ── wired into both endpoints ───────────────────────────────────────────────
def test_chat_hands_the_emitter_the_same_id_it_returned(client, captured):
    returned = client.post("/v1/chat/completions", json=CHAT_BODY).json()["gateway_call_id"]
    assert len(captured) == 1
    # If these ever diverge the join is silently wrong rather than absent, which
    # is worse than not having it.
    assert captured[0]["gateway_call_id"] == returned


def test_embeddings_hands_the_emitter_the_same_id_it_returned(client, captured):
    returned = client.post("/v1/embeddings", json=EMBED_BODY).json()["gateway_call_id"]
    assert len(captured) == 1
    assert captured[0]["gateway_call_id"] == returned


def test_chat_emission_carries_identity_and_provenance(client, captured):
    client.post("/v1/chat/completions", json=CHAT_BODY)
    kw = captured[0]
    assert kw["endpoint"] == "chat_completions"
    assert kw["provider"] == "mock"
    assert kw["trace_id"] == "trace-abc"
    assert kw["capability_id"] == "cap-1"
    assert kw["tenant_id"] == "tenant-1"
    assert kw["actor_id"] == "user-7"
    assert kw["identity"]["task_tag"] == "agent_turn"
    # A caller that pins provider/model is a caller_pin, not a default.
    assert kw["routing_source"] == "caller_pin"


def test_embeddings_emission_self_identifies_as_embedding(client, captured):
    """Embeddings are the highest-volume traffic; untagged they would be the
    biggest unattributable cost line."""
    client.post("/v1/embeddings", json=EMBED_BODY)
    assert captured[0]["identity"]["task_tag"] == "embedding"
    assert captured[0]["endpoint"] == "embeddings"


def test_router_sends_fingerprints_never_text(client, captured):
    client.post("/v1/chat/completions", json=CHAT_BODY)
    kw = captured[0]
    assert len(kw["prompt_sha256"]) == 64
    assert kw["prompt_chars"] == len("what is the capital of France")
    assert len(kw["response_sha256"]) == 64
    # The prompt text itself must appear nowhere in what the emitter is given.
    assert "capital of France" not in repr(kw)


def test_embeddings_fingerprints_the_input_without_carrying_it(client, captured):
    client.post("/v1/embeddings", json=EMBED_BODY)
    kw = captured[0]
    assert len(kw["prompt_sha256"]) == 64
    assert "a document chunk to embed" not in repr(kw)


# ── off is off ──────────────────────────────────────────────────────────────
def test_disabled_flag_sends_nothing_but_still_serves(client):
    """The rollout guarantee: dark by default means the endpoints behave exactly
    as they did before this emitter existed."""
    posted = []
    import httpx
    original = httpx.AsyncClient

    class Tripwire(original):  # type: ignore[misc,valid-type]
        async def post(self, *a, **k):  # noqa: ANN002,ANN003
            posted.append(a)
            raise AssertionError("nothing may be emitted while the flag is off")

    httpx.AsyncClient = Tripwire
    try:
        res = client.post("/v1/chat/completions", json=CHAT_BODY)
    finally:
        httpx.AsyncClient = original
    assert res.status_code == 200
    assert posted == []
    assert audit_emit.queue_depth() == 0


def test_emitter_failure_does_not_fail_the_llm_call(client, monkeypatch):
    """The invariant that makes this safe to switch on at all."""
    def boom(**_kw):
        raise RuntimeError("emitter exploded")

    monkeypatch.setattr(audit_emit, "emit_llm_call", boom)
    # emit_llm_call is the guarded entry point; the router calls it bare, so if
    # its own guard ever regressed this request would 500.
    with pytest.raises(RuntimeError):
        client.post("/v1/chat/completions", json=CHAT_BODY)


def test_real_emitter_swallows_its_own_failure_on_the_router_path(client, monkeypatch):
    """Same scenario, but through the REAL emit_llm_call: an internal explosion
    is contained and the caller still gets their completion."""
    monkeypatch.setenv("GATEWAY_AUDIT_EMIT_ENABLED", "true")

    def boom(**_kw):
        raise RuntimeError("builder exploded")

    monkeypatch.setattr(audit_emit, "build_event", boom)
    res = client.post("/v1/chat/completions", json=CHAT_BODY)
    assert res.status_code == 200
    assert res.json()["content"]
