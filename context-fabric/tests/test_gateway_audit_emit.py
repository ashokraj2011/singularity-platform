"""
The gateway's cost emitter.

`audit_governance.llm_calls` has the right columns and is dead: nothing live
emits into it, so no call the platform has ever made has produced a cost row.
The gateway is the only component that sees every LLM egress, so it becomes the
emitter. What is pinned here is what makes that safe to switch on:

  - DARK BY DEFAULT. With GATEWAY_AUDIT_EMIT_ENABLED unset, nothing is built,
    nothing is queued, nothing is sent. Today's behaviour, exactly.
  - NEVER RAISES. This runs on the hottest path in the platform. A telemetry
    failure must not fail the call it describes — including when the payload
    builder itself throws.
  - NEVER TEXT. Prompt and response bodies do not enter the payload. Hashes and
    char counts only.
  - THE PAYLOAD ACTUALLY PARSES. The single highest-value property, because the
    failure mode is silent: cost-worker.ts safeParses against llmCallPayload and
    returns quietly, so a mismatch produces no row and no error — indistinguish-
    able from the bug this change exists to fix. The fixture asserted here is
    the same one audit-governance-service's vitest suite parses against the real
    zod schema, so drift on either side fails a test.
  - BOUNDED, AT-MOST-ONCE. The retry queue is in-process and capped on purpose;
    see audit_emit's module docstring for why a durable outbox is the wrong
    trade for this service.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from llm_gateway_service.app import audit_emit


FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "audit-governance-service" / "test" / "fixtures"
    / "gateway-llm-call-payload.json"
)

PROMPT_TEXT = "SYSTEM PROMPT AND USER TURN"
RESPONSE_TEXT = "MODEL RESPONSE TEXT"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    audit_emit.reset_for_tests()
    monkeypatch.delenv("GATEWAY_AUDIT_EMIT_ENABLED", raising=False)
    yield
    audit_emit.reset_for_tests()


def _enable(monkeypatch):
    monkeypatch.setenv("GATEWAY_AUDIT_EMIT_ENABLED", "true")


def _call(**overrides):
    base = dict(
        gateway_call_id="6f1a9c4e-3b2d-4f8a-9c1e-7d5b2a8f0c31",
        endpoint="chat_completions",
        provider="anthropic",
        model="claude-sonnet-4-5-20250929",
        model_alias="balanced",
        identity={"task_tag": "agent_turn", "stage": "develop", "purpose": "code_edit"},
        input_tokens=4211,
        output_tokens=317,
        latency_ms=8420,
        finish_reason="stop",
        routing_source="caller_pin",
        estimated_cost=0.017388,
        trace_id="trace-7f3c",
        capability_id="cap-sdlc-dev",
        tenant_id="tenant-acme",
        actor_id="user-1042",
        run_id="run-88",
        prompt_sha256=audit_emit.sha256_text(PROMPT_TEXT),
        prompt_chars=len(PROMPT_TEXT),
        response_sha256=audit_emit.sha256_text(RESPONSE_TEXT),
        response_chars=len(RESPONSE_TEXT),
    )
    base.update(overrides)
    return base


# ── dark by default ─────────────────────────────────────────────────────────
def test_disabled_by_default():
    assert audit_emit.emit_enabled() is False


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", " yes ", "on"])
def test_enable_flag_accepts_the_usual_truthy_spellings(monkeypatch, raw):
    monkeypatch.setenv("GATEWAY_AUDIT_EMIT_ENABLED", raw)
    assert audit_emit.emit_enabled() is True


@pytest.mark.parametrize("raw", ["", "0", "false", "no", "off", "maybe"])
def test_anything_else_leaves_it_off(monkeypatch, raw):
    monkeypatch.setenv("GATEWAY_AUDIT_EMIT_ENABLED", raw)
    assert audit_emit.emit_enabled() is False


def test_disabled_emits_nothing(monkeypatch):
    """Off must mean OFF — not "built and dropped". Nothing queued, and the
    payload builder is never even reached."""
    called = []
    monkeypatch.setattr(audit_emit, "build_event", lambda **kw: called.append(kw))
    audit_emit.emit_llm_call(**_call())
    assert called == []
    assert audit_emit.queue_depth() == 0


def test_enabled_queues_exactly_one_event(monkeypatch):
    _enable(monkeypatch)
    audit_emit.emit_llm_call(**_call())
    assert audit_emit.queue_depth() == 1


# ── never raises ────────────────────────────────────────────────────────────
def test_builder_exception_never_propagates(monkeypatch):
    """The invariant that lets this sit on the hot path: if the emitter is
    broken, the LLM call it describes still succeeds."""
    _enable(monkeypatch)

    def boom(**_kw):
        raise ValueError("emitter is broken")

    monkeypatch.setattr(audit_emit, "build_event", boom)
    audit_emit.emit_llm_call(**_call())  # must not raise
    assert audit_emit.queue_depth() == 0


def test_enqueue_exception_never_propagates(monkeypatch):
    _enable(monkeypatch)

    def boom(*_a, **_kw):
        raise RuntimeError("queue is broken")

    monkeypatch.setattr(audit_emit, "_enqueue", boom)
    audit_emit.emit_llm_call(**_call())


def test_flag_read_exception_never_propagates(monkeypatch):
    def boom():
        raise OSError("env is broken")

    monkeypatch.setattr(audit_emit, "emit_enabled", boom)
    audit_emit.emit_llm_call(**_call())


def test_missing_required_field_never_propagates(monkeypatch):
    """A caller that forgets a kwarg gets no event, not a 500 on their LLM call."""
    _enable(monkeypatch)
    audit_emit.emit_llm_call(endpoint="chat_completions")


def test_no_event_loop_is_survivable(monkeypatch):
    """Called from a sync context there is nothing to schedule the drain onto.
    That must be a no-op, not a crash."""
    _enable(monkeypatch)
    audit_emit.emit_llm_call(**_call())
    assert audit_emit.queue_depth() == 1  # queued, drains on the next call with a loop


def test_post_failure_never_propagates():
    """httpx blowing up is the expected failure, not an exceptional one."""
    async def run():
        class Boom:
            def __init__(self, *a, **k):
                raise ConnectionError("audit-gov is down")

        import httpx
        original = httpx.AsyncClient
        httpx.AsyncClient = Boom
        try:
            return await audit_emit._post({"kind": "llm.call.completed"})
        finally:
            httpx.AsyncClient = original

    assert asyncio.run(run()) is False


# ── never text ──────────────────────────────────────────────────────────────
def test_payload_carries_no_prompt_or_response_text():
    """Checked against the serialized event, not a field list, so a future field
    cannot smuggle content past this."""
    event = audit_emit.build_event(**_call())
    blob = json.dumps(event)
    assert PROMPT_TEXT not in blob
    assert RESPONSE_TEXT not in blob
    for banned in ("messages", "content", "prompt_text", "response_text", "input", "text"):
        assert banned not in event["payload"], f"{banned} must not be on the payload"


def test_fingerprints_are_real_sha256_of_the_content():
    sha, chars = audit_emit.fingerprint(PROMPT_TEXT)
    assert sha == hashlib.sha256(PROMPT_TEXT.encode()).hexdigest()
    assert len(sha) == 64
    assert chars == len(PROMPT_TEXT)


def test_message_fingerprint_respects_message_boundaries():
    """A fingerprint that just concatenates would call two materially different
    prompts identical."""
    a, _ = audit_emit.fingerprint_messages(
        [{"role": "user", "content": "ab"}, {"role": "user", "content": "c"}]
    )
    b, _ = audit_emit.fingerprint_messages(
        [{"role": "user", "content": "a"}, {"role": "user", "content": "bc"}]
    )
    assert a != b


def test_message_fingerprint_counts_content_chars_only():
    """The count must exclude the role tags and separators the hash needs, or
    prompt_chars drifts from the real prompt size by a per-message constant and
    stops being comparable to response_chars."""
    _, chars = audit_emit.fingerprint_messages(
        [{"role": "system", "content": "abc"}, {"role": "user", "content": "de"}]
    )
    assert chars == 5


def test_message_fingerprint_is_stable_and_never_raises():
    msgs = [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}]
    assert audit_emit.fingerprint_messages(msgs) == audit_emit.fingerprint_messages(msgs)
    # Junk in, None out — never an exception on the hot path.
    assert audit_emit.fingerprint_messages(None) == (None, None)
    assert audit_emit.fingerprint_messages([]) == (None, None)
    assert audit_emit.fingerprint_messages([object()]) == audit_emit.fingerprint_messages(
        [{"role": None, "content": None}]
    )


def test_sha256_of_nothing_is_none():
    assert audit_emit.sha256_text(None) is None
    assert audit_emit.sha256_text("") is None
    assert audit_emit.sha256_text(42) is None


# ── the payload the cost worker actually has to accept ──────────────────────
def test_payload_matches_the_checked_in_contract_fixture():
    """The seam between two languages that cannot import each other.

    audit-governance-service/test/gateway-llm-call-payload.contract.test.ts
    parses this same file against the REAL llmCallPayload zod schema. If this
    assertion fails, regenerate with
    audit-governance-service/test/fixtures/regenerate-gateway-fixture.py and
    make sure the TS side still passes — a payload the schema rejects produces
    no cost row and no error at all.
    """
    if not FIXTURE.exists():
        pytest.skip("audit-governance-service not present (context-fabric checked out alone)")
    expected = json.loads(FIXTURE.read_text())["chat_completions"]
    assert audit_emit.build_event(**_call()) == expected


def test_event_envelope_is_what_the_cost_worker_keys_on():
    event = audit_emit.build_event(**_call())
    # ingestOne only calls denormaliseLlmCall for this exact kind.
    assert event["kind"] == "llm.call.completed"
    assert event["source_service"] == "llm-gateway"
    # subject_id == gateway_call_id is what lets the audit_events row and the
    # llm_calls row join exactly instead of by timestamp proximity.
    assert event["subject_id"] == event["payload"]["gateway_call_id"]
    # The cost worker reads these off the ENVELOPE, not the payload.
    assert event["trace_id"] == "trace-7f3c"
    assert event["capability_id"] == "cap-sdlc-dev"
    assert event["tenant_id"] == "tenant-acme"


def test_total_tokens_is_derived_not_trusted():
    event = audit_emit.build_event(**_call(input_tokens=10, output_tokens=5))
    assert event["payload"]["total_tokens"] == 15


def test_catalog_price_is_labelled_as_such():
    """audit-gov's rate_card and the gateway catalog can legitimately disagree.
    The row has to say which one it came from or the disagreement is a mystery."""
    payload = audit_emit.build_event(**_call())["payload"]
    assert payload["cost_usd"] == 0.017388
    assert payload["price_source"] == "gateway_catalog"


def test_absent_price_omits_both_price_fields():
    """No catalog price must mean "unpriced", not "$0.00"."""
    payload = audit_emit.build_event(**_call(estimated_cost=None))["payload"]
    assert "cost_usd" not in payload
    assert "price_source" not in payload


def test_absent_optional_fields_are_omitted_not_nulled():
    """zod's .optional() accepts a missing key; an explicit null would fail the
    parse and take the whole cost row with it."""
    payload = audit_emit.build_event(
        gateway_call_id="c0ffee00-0000-4000-8000-000000000000",
        endpoint="embeddings", provider="mock", model="mock-embed",
    )["payload"]
    for key in ("model_alias", "task_tag", "stage", "purpose", "actor_id",
                "finish_reason", "latency_ms", "prompt_sha256"):
        assert key not in payload
    assert None not in payload.values()


def test_actor_id_rides_both_envelope_and_payload():
    """The envelope drives audit_events; the payload drives the llm_calls
    column. Only one of them would leave the other blank."""
    event = audit_emit.build_event(**_call(actor_id="user-1042"))
    assert event["actor_id"] == "user-1042"
    assert event["payload"]["actor_id"] == "user-1042"


def test_negative_and_bogus_token_counts_do_not_poison_the_payload():
    """llmCallPayload requires nonnegative ints; a negative would fail the parse
    and silently drop the row."""
    payload = audit_emit.build_event(**_call(input_tokens=-5, output_tokens=None))["payload"]
    assert payload["input_tokens"] == 0
    assert payload["output_tokens"] == 0
    assert payload["total_tokens"] == 0


def test_embeddings_payload_matches_the_contract_fixture():
    if not FIXTURE.exists():
        pytest.skip("audit-governance-service not present")
    expected = json.loads(FIXTURE.read_text())["embeddings"]
    built = audit_emit.build_event(
        gateway_call_id="b2c4d6e8-1a3f-4b5c-8d9e-0f1a2b3c4d5e",
        endpoint="embeddings", provider="openai", model="text-embedding-3-small",
        model_alias="embed-small",
        identity={"task_tag": "embedding", "stage": None, "purpose": None},
        input_tokens=912, output_tokens=0, latency_ms=140,
        routing_source="default", estimated_cost=0.0000182,
        trace_id="trace-91ab", capability_id="cap-world-model", tenant_id="tenant-acme",
        actor_id="system:context-fabric",
        prompt_sha256=audit_emit.sha256_text("DOCUMENT CHUNK TEXT"), prompt_chars=19,
    )
    assert built == expected
    # Embeddings produce vectors, not tokens, and there is no response text to
    # fingerprint — a hash of a float array would tell nobody anything.
    assert built["payload"]["output_tokens"] == 0
    assert "response_sha256" not in built["payload"]


# ── bounded, at-most-once ───────────────────────────────────────────────────
def test_queue_is_bounded_and_drops_oldest_first(monkeypatch):
    """At-most-once is the accepted trade (see the module docstring). What is
    NOT acceptable is unbounded memory growth on the hottest service we run."""
    _enable(monkeypatch)
    monkeypatch.setattr(audit_emit, "_ensure_drain", lambda: None)
    maxlen = audit_emit._queue.maxlen
    for i in range(maxlen + 25):
        audit_emit.emit_llm_call(**_call(trace_id=f"trace-{i}"))
    assert audit_emit.queue_depth() == maxlen
    assert audit_emit.dropped_count() == 25
    # Newest survives — during an incident, recent cost data is the data an
    # operator is actually looking at.
    assert audit_emit._queue[-1]["body"]["trace_id"] == f"trace-{maxlen + 24}"


def test_drain_retries_a_failure_then_gives_up(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(audit_emit, "RETRY_DELAY_SEC", 0.0)
    attempts = []

    async def always_fail(body):
        attempts.append(body)
        return False

    monkeypatch.setattr(audit_emit, "_post", always_fail)

    async def run():
        audit_emit._enqueue({"kind": "llm.call.completed"}, "call-1")
        await audit_emit._drain()

    asyncio.run(run())
    assert len(attempts) == audit_emit.MAX_ATTEMPTS
    assert audit_emit.queue_depth() == 0  # given up, not stuck forever


def test_drain_stops_on_success(monkeypatch):
    _enable(monkeypatch)
    calls = []

    async def ok(body):
        calls.append(body)
        return True

    monkeypatch.setattr(audit_emit, "_post", ok)

    async def run():
        audit_emit._enqueue({"kind": "a"}, "a")
        audit_emit._enqueue({"kind": "b"}, "b")
        await audit_emit._drain()

    asyncio.run(run())
    assert len(calls) == 2
    assert audit_emit.queue_depth() == 0


def test_drain_never_raises(monkeypatch):
    async def boom(_body):
        raise RuntimeError("post exploded")

    monkeypatch.setattr(audit_emit, "_post", boom)

    async def run():
        audit_emit._enqueue({"kind": "a"}, "a")
        await audit_emit._drain()

    asyncio.run(run())  # must not raise


def test_emitted_end_to_end_when_enabled(monkeypatch):
    """The whole path: enabled → built → queued → drained → posted once."""
    _enable(monkeypatch)
    posted = []

    async def ok(body):
        posted.append(body)
        return True

    monkeypatch.setattr(audit_emit, "_post", ok)

    async def run():
        audit_emit.emit_llm_call(**_call())
        await asyncio.sleep(0)  # let the drain task run
        for _ in range(5):
            if posted:
                break
            await asyncio.sleep(0.01)

    asyncio.run(run())
    assert len(posted) == 1
    assert posted[0]["kind"] == "llm.call.completed"
    assert posted[0]["payload"]["gateway_call_id"] == "6f1a9c4e-3b2d-4f8a-9c1e-7d5b2a8f0c31"


# ── config bounds ───────────────────────────────────────────────────────────
def test_emit_knobs_are_bounded():
    assert 0.5 <= audit_emit.EMIT_TIMEOUT_SEC <= 60.0
    assert 1 <= audit_emit.QUEUE_MAX <= 100_000
    assert 1 <= audit_emit.MAX_ATTEMPTS <= 10
    assert 0.0 <= audit_emit.RETRY_DELAY_SEC <= 60.0


@pytest.mark.parametrize(
    "raw,expected",
    [(None, 5.0), ("bad", 5.0), ("0.1", 5.0), ("12.5", 12.5), ("9999", 60.0)],
)
def test_timeout_env_is_bounded(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("GATEWAY_AUDIT_EMIT_TIMEOUT_SEC", raising=False)
    else:
        monkeypatch.setenv("GATEWAY_AUDIT_EMIT_TIMEOUT_SEC", raw)
    assert audit_emit._bounded_float_env(
        "GATEWAY_AUDIT_EMIT_TIMEOUT_SEC", 5.0, min_value=0.5, max_value=60.0,
    ) == expected
