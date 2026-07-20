"""
Secret redaction at the LLM gateway.

Before this, `turn.py:_SECRET_MASKS` masked secrets in the *audit copy* and sent
the originals to the provider verbatim. The gateway is the platform's only
egress choke point, so redaction belongs there.

What is pinned here:
  - each structural pattern matches the credential shape it names
  - realistic source code — IPv4, semver, UUID — is NOT touched, and neither is
    a generic `api_key = "..."` config line. That exclusion is a deliberate
    judgement call: on the egress path a false positive silently corrupts the
    prompt an agent was asked to reason about, and a confidently wrong answer
    is worse than the leak. If someone "fixes" the gap, these tests fail.
  - shadow (the default) measures and changes nothing; enforce rewrites; off
    does neither
  - findings and the log line carry pattern name + count, NEVER matched text —
    a redaction log that leaks the secret is worse than no redaction
  - a failure inside redaction falls through to the original body: this sits in
    front of every LLM call on the platform and must not be able to stop one
"""
from __future__ import annotations

import asyncio
import logging

import pytest

from llm_gateway_service.app import secret_redaction as sr


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """These are read per-call from the ambient environment; a developer with
    either flag exported would otherwise silently change what is under test."""
    monkeypatch.delenv("GATEWAY_REDACT_SECRETS", raising=False)
    monkeypatch.delenv("GATEWAY_REQUIRE_TASK_TAG", raising=False)


def _msg(content, role="user"):
    return {"role": role, "content": content}


# ── the patterns ─────────────────────────────────────────────────────────────
GOOGLE_KEY = "AIza" + "b" * 35
PEM_BLOCK = (
    "-----BEGIN RSA PRIVATE KEY-----\n"
    "MIIEowIBAAKCAQEAnotarealkeyatall0000\n"
    "-----END RSA PRIVATE KEY-----"
)

SAMPLES = [
    ("bearer_token", "curl -H 'Bearer aaaaaaaaaaaabbbbbbbbbbbb' https://x", "aaaaaaaaaaaabbbbbbbbbbbb"),
    ("authorization_value", 'authorization: aaaaaaaaaaaabbbbbbbbbbbb', "aaaaaaaaaaaabbbbbbbbbbbb"),
    ("openai_api_key", "OPENAI=sk-ABCDEFGHIJKLMNOP1234 done", "sk-ABCDEFGHIJKLMNOP1234"),
    ("scoped_api_key", "key sk-ant-api03-AAAAbbbbCCCCddddEEEE-ffff here", "sk-ant-api03-AAAAbbbbCCCCddddEEEE-ffff"),
    ("scoped_api_key", "key sk-proj-AAAAbbbbCCCCddddEEEE_ffff here", "sk-proj-AAAAbbbbCCCCddddEEEE_ffff"),
    ("github_token", "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ok", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
    ("aws_access_key_id", "aws id AKIAIOSFODNN7EXAMPLE ok", "AKIAIOSFODNN7EXAMPLE"),
    ("slack_token", "slack xoxb-123456789012-abcdefghijkl ok", "xoxb-123456789012-abcdefghijkl"),
    ("google_api_key", f"maps {GOOGLE_KEY} ok", GOOGLE_KEY),
    ("private_key_block", f"deploy key:\n{PEM_BLOCK}\n", "MIIEowIBAAKCAQEAnotarealkeyatall0000"),
]


@pytest.mark.parametrize("rule_name,content,secret", SAMPLES, ids=[f"{n}-{i}" for i, (n, _, _) in enumerate(SAMPLES)])
def test_each_pattern_matches_its_credential_shape(rule_name, content, secret):
    redacted, findings = sr.redact_messages([_msg(content)])
    assert findings == [{"pattern_name": rule_name, "count": 1}]
    assert secret not in redacted[0]["content"]


def test_rule_names_are_unique():
    """Two rules sharing a name would silently merge their counts, making the
    shadow numbers unattributable to a pattern."""
    names = [r.name for r in sr._SECRET_RULES]
    assert len(names) == len(set(names))


# ── false positives: the whole reason this is conservative ───────────────────
def test_realistic_source_code_is_left_alone():
    """An IPv4, a semver and a UUID are the shapes most likely to be mistaken
    for high-entropy secrets. If any rule eats them, an agent reading real code
    reasons about mangled input."""
    code = (
        'DEFAULT_HOST = "192.168.1.100"\n'
        'SCHEMA_VERSION = "2.14.0"\n'
        'RUN_ID = "550e8400-e29b-41d4-a716-446655440000"\n'
        "if response.status_code == 200:\n"
        '    return {"host": DEFAULT_HOST, "version": SCHEMA_VERSION}\n'
    )
    redacted, findings = sr.redact_messages([_msg(code)])
    assert findings == []
    assert redacted[0]["content"] == code


def test_generic_key_value_config_is_deliberately_not_redacted():
    """turn.py's generic (api_key|secret|password|token)\\s*[:=]\\s*.{8,} rule is
    NOT ported and must not come back. It is free on an audit copy and actively
    harmful on egress: it hits ordinary config and source the agent was asked to
    read, producing a silently wrong answer. Deliberate — do not "fix"."""
    config = (
        'api_key = "supersecretvalue123"\n'
        "password: hunter2hunter2\n"
        "DATABASE_TOKEN=abcdefgh12345678\n"
        "secret = 'my-very-secret-value'\n"
    )
    redacted, findings = sr.redact_messages([_msg(config)])
    assert findings == []
    assert redacted[0]["content"] == config


# ── findings ─────────────────────────────────────────────────────────────────
def test_findings_never_contain_the_secret():
    secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
    _, findings = sr.redact_messages([_msg(f"use {secret} now")])
    assert secret not in repr(findings)
    assert set(findings[0]) == {"pattern_name", "count"}


def test_counts_accumulate_across_messages():
    secret = "AKIAIOSFODNN7EXAMPLE"
    _, findings = sr.redact_messages([
        _msg(f"first {secret}"),
        _msg(f"second {secret} and {secret}", role="assistant"),
    ])
    assert findings == [{"pattern_name": "aws_access_key_id", "count": 3}]


def test_findings_are_ordered_by_rule_not_by_match():
    """Rule order keeps the same body reporting identically every time."""
    body = "AKIAIOSFODNN7EXAMPLE and Bearer aaaaaaaaaaaabbbbbbbbbbbb"
    _, findings = sr.redact_messages([_msg(body)])
    assert [f["pattern_name"] for f in findings] == ["bearer_token", "aws_access_key_id"]


# ── purity ───────────────────────────────────────────────────────────────────
def test_input_messages_are_never_mutated():
    """Shadow mode still sends the caller's originals, so mutating them in place
    would make shadow silently behave like enforce."""
    original = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
    messages = [_msg(original)]
    redacted, _ = sr.redact_messages(messages)
    assert messages[0]["content"] == original
    assert redacted[0] is not messages[0]


def test_pydantic_messages_round_trip_with_other_fields_intact():
    from llm_gateway_service.app.types import ChatMessage

    msg = ChatMessage(role="tool", content="key sk-ABCDEFGHIJKLMNOP1234", tool_call_id="call-1")
    redacted, findings = sr.redact_messages([msg])
    assert findings[0]["pattern_name"] == "openai_api_key"
    assert redacted[0].tool_call_id == "call-1"
    assert redacted[0].role == "tool"
    assert "sk-ABCDEFGHIJKLMNOP1234" not in redacted[0].content
    assert msg.content == "key sk-ABCDEFGHIJKLMNOP1234"  # untouched


@pytest.mark.parametrize("content", [None, "", 123, {"nested": "block"}, []])
def test_non_string_content_is_passed_through(content):
    messages = [{"role": "user", "content": content}]
    redacted, findings = sr.redact_messages(messages)
    assert findings == []
    assert redacted[0] is messages[0]


def test_empty_and_none_message_lists_are_safe():
    assert sr.redact_messages([]) == ([], [])
    assert sr.redact_messages(None) == ([], [])


# ── mode gate ────────────────────────────────────────────────────────────────
def test_default_mode_is_shadow():
    """Measure before enforcing: the default must never rewrite traffic."""
    assert sr.redaction_mode() == sr.MODE_SHADOW


@pytest.mark.parametrize("value,expected", [
    ("shadow", "shadow"), ("enforce", "enforce"), ("off", "off"),
    ("ENFORCE", "enforce"), ("  Off  ", "off"), ("", "shadow"),
])
def test_mode_parsing(monkeypatch, value, expected):
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", value)
    assert sr.redaction_mode() == expected


def test_mode_is_read_per_call(monkeypatch):
    """Read at call time, not import time, so an operator can move to enforce —
    or pull straight back out of it — without restarting the gateway."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "enforce")
    assert sr.redaction_mode() == "enforce"
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "off")
    assert sr.redaction_mode() == "off"


def test_unknown_mode_falls_back_to_shadow_and_warns(monkeypatch, caplog):
    """An ambiguous configuration must mean "change nothing about the traffic",
    but it must not do so silently — a typo'd flag would look like enforcement."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "true")
    with caplog.at_level(logging.WARNING, logger="llm_gateway.redaction"):
        assert sr.redaction_mode() == sr.MODE_SHADOW
    assert any("redaction_unknown_mode" in r.getMessage() for r in caplog.records)


# ── egress behaviour ─────────────────────────────────────────────────────────
SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
BODY = f"deploy with {SECRET} please"


def test_shadow_sends_the_body_byte_identical(monkeypatch):
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "shadow")
    messages = [_msg(BODY)]
    out = sr.redact_for_egress(messages, endpoint="chat_completions")
    assert out is messages
    assert out[0]["content"] == BODY


def test_shadow_logs_findings_without_the_secret(monkeypatch, caplog):
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "shadow")
    with caplog.at_level(logging.WARNING, logger="llm_gateway.redaction"):
        sr.redact_for_egress([_msg(BODY)], endpoint="chat_completions", model_alias="fast", trace_id="t-1")
    line = "\n".join(r.getMessage() for r in caplog.records)
    assert "llm_gateway.secret_redaction" in line
    assert "mode=shadow" in line
    assert "github_token:1" in line
    assert "model_alias=fast" in line and "trace_id=t-1" in line
    assert SECRET not in line


def test_enforce_sends_the_redacted_body(monkeypatch):
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "enforce")
    messages = [_msg(BODY)]
    out = sr.redact_for_egress(messages, endpoint="chat_completions")
    assert out is not messages
    assert SECRET not in out[0]["content"]
    assert messages[0]["content"] == BODY  # caller's list untouched


def test_off_skips_entirely(monkeypatch, caplog):
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "off")
    messages = [_msg(BODY)]
    with caplog.at_level(logging.WARNING, logger="llm_gateway.redaction"):
        out = sr.redact_for_egress(messages, endpoint="chat_completions")
    assert out is messages
    assert caplog.records == []


def test_a_clean_body_logs_nothing(monkeypatch, caplog):
    """No findings, no line — otherwise the signal drowns in per-call noise."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "shadow")
    with caplog.at_level(logging.WARNING, logger="llm_gateway.redaction"):
        sr.redact_for_egress([_msg("just an ordinary prompt")], endpoint="chat_completions")
    assert caplog.records == []


@pytest.mark.parametrize("mode", ["shadow", "enforce"])
def test_redaction_failure_falls_through_to_the_original_body(monkeypatch, mode, caplog):
    """This sits in front of every LLM call on the platform. A bug here must
    degrade to today's behaviour, not take LLM traffic down."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", mode)

    def _explode(_messages):
        raise RuntimeError(f"boom while scanning {SECRET}")

    monkeypatch.setattr(sr, "redact_messages", _explode)
    messages = [_msg(BODY)]
    with caplog.at_level(logging.ERROR, logger="llm_gateway.redaction"):
        out = sr.redact_for_egress(messages, endpoint="chat_completions")
    assert out is messages
    assert out[0]["content"] == BODY

    line = "\n".join(r.getMessage() for r in caplog.records)
    assert "redaction_failed" in line and "error_type=RuntimeError" in line
    # The exception MESSAGE is never logged — it can quote the very input this
    # module exists to keep out of the logs.
    assert SECRET not in line


def test_a_logging_failure_cannot_defeat_enforcement(monkeypatch):
    """Regression: with the audit line written inside the same try that decides
    what to send, a failure while logging took the fall-through path and shipped
    the ORIGINAL body — an observability bug silently disabling enforcement."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "enforce")

    def _explode(**_kw):
        raise RuntimeError("logger down")

    monkeypatch.setattr(sr, "_log_findings", _explode)
    out = sr.redact_for_egress([_msg(BODY)], endpoint="chat_completions")
    assert SECRET not in out[0]["content"]


# ── router wiring ────────────────────────────────────────────────────────────
def _run_chat(monkeypatch, content):
    """Drive router.chat_completions to the provider hop and capture what the
    provider was actually handed."""
    from llm_gateway_service.app import router as gw_router
    from llm_gateway_service.app.types import (
        ChatCompletionRequest,
        ChatCompletionResponse,
        ChatMessage,
    )

    # 4-tuple: the resolver reports routing_source alongside the resolution (m75).
    monkeypatch.setattr(
        gw_router, "_resolve_provider_and_model",
        lambda **_kw: ("mock", "mock-fast", None, "fallback"),
    )
    monkeypatch.setattr(gw_router.provider_config, "is_provider_allowed", lambda _p: True)
    monkeypatch.setattr(gw_router.settings, "gateway_bearer", "")

    seen = {}

    async def _fake_respond(req, *, resolved_model):
        seen["contents"] = [m.content for m in req.messages]
        return ChatCompletionResponse(
            content="ok", finish_reason="stop", provider="mock", model=resolved_model,
        )

    monkeypatch.setattr(gw_router.mock_provider, "respond", _fake_respond)
    req = ChatCompletionRequest(
        messages=[ChatMessage(role="user", content=content)], task_tag="agent_turn",
    )
    asyncio.run(gw_router.chat_completions(req, None))
    return seen["contents"]


def test_router_redacts_before_the_provider_call_under_enforce(monkeypatch):
    """The wiring, not the regex: the provider must never see the secret."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "enforce")
    contents = _run_chat(monkeypatch, BODY)
    assert SECRET not in contents[0]
    assert "«redacted-token»" in contents[0]


def test_router_under_shadow_still_sends_the_original(monkeypatch):
    """Shadow protects nothing by design — it only measures. Pinned so nobody
    mistakes the default for protection."""
    monkeypatch.setenv("GATEWAY_REDACT_SECRETS", "shadow")
    contents = _run_chat(monkeypatch, BODY)
    assert contents[0] == BODY
