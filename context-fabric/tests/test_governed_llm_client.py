"""Wire-format tests for the llm-gateway client.

Pinned by the 2026-05-24 RCA: the gateway's
`llm_gateway_service.app.types.ToolCall` model serializes tool args
under the field name `args`. The earlier ChatToolCall.from_dict only
read `arguments`, which silently turned every tool call into
`args={}`. Across the governed loop that bug looked exactly like "the
LLM keeps calling submit_phase_output with empty payload" and burned
~24 hours of operator time before we caught it. These tests are the
regression seal — if anyone ever changes the read order back to
`arguments`-only, the unit suite breaks immediately.
"""
from __future__ import annotations

from context_api_service.app.governed.llm_client import ChatToolCall, _bounded_float_env


def test_llm_gateway_timeout_env_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("LLM_GATEWAY_TIMEOUT_SEC", raising=False)
    assert _bounded_float_env(
        "LLM_GATEWAY_TIMEOUT_SEC",
        default=300.0,
        min_value=1.0,
        max_value=7200.0,
    ) == 300.0

    monkeypatch.setenv("LLM_GATEWAY_TIMEOUT_SEC", "not-a-float")
    assert _bounded_float_env(
        "LLM_GATEWAY_TIMEOUT_SEC",
        default=300.0,
        min_value=1.0,
        max_value=7200.0,
    ) == 300.0

    monkeypatch.setenv("LLM_GATEWAY_TIMEOUT_SEC", "0")
    assert _bounded_float_env(
        "LLM_GATEWAY_TIMEOUT_SEC",
        default=300.0,
        min_value=1.0,
        max_value=7200.0,
    ) == 300.0

    monkeypatch.setenv("LLM_GATEWAY_TIMEOUT_SEC", "900.5")
    assert _bounded_float_env(
        "LLM_GATEWAY_TIMEOUT_SEC",
        default=300.0,
        min_value=1.0,
        max_value=7200.0,
    ) == 900.5

    monkeypatch.setenv("LLM_GATEWAY_TIMEOUT_SEC", "999999")
    assert _bounded_float_env(
        "LLM_GATEWAY_TIMEOUT_SEC",
        default=300.0,
        min_value=1.0,
        max_value=7200.0,
    ) == 7200.0


def test_llm_gateway_discovery_ttl_env_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("LLM_GATEWAY_DISCOVERY_TTL_SEC", raising=False)
    assert _bounded_float_env(
        "LLM_GATEWAY_DISCOVERY_TTL_SEC",
        default=30.0,
        min_value=1.0,
        max_value=86400.0,
    ) == 30.0

    monkeypatch.setenv("LLM_GATEWAY_DISCOVERY_TTL_SEC", "invalid")
    assert _bounded_float_env(
        "LLM_GATEWAY_DISCOVERY_TTL_SEC",
        default=30.0,
        min_value=1.0,
        max_value=86400.0,
    ) == 30.0

    monkeypatch.setenv("LLM_GATEWAY_DISCOVERY_TTL_SEC", "0")
    assert _bounded_float_env(
        "LLM_GATEWAY_DISCOVERY_TTL_SEC",
        default=30.0,
        min_value=1.0,
        max_value=86400.0,
    ) == 30.0

    monkeypatch.setenv("LLM_GATEWAY_DISCOVERY_TTL_SEC", "45.25")
    assert _bounded_float_env(
        "LLM_GATEWAY_DISCOVERY_TTL_SEC",
        default=30.0,
        min_value=1.0,
        max_value=86400.0,
    ) == 45.25

    monkeypatch.setenv("LLM_GATEWAY_DISCOVERY_TTL_SEC", "999999")
    assert _bounded_float_env(
        "LLM_GATEWAY_DISCOVERY_TTL_SEC",
        default=30.0,
        min_value=1.0,
        max_value=86400.0,
    ) == 86400.0


def test_from_dict_reads_gateway_args_field():
    """The llm-gateway's canonical field name. Must not regress."""
    raw = {
        "id": "tc-1",
        "name": "submit_phase_output",
        "args": {"payload": {"x": 1}, "next_phase": "EXPLORE"},
    }
    call = ChatToolCall.from_dict(raw)
    assert call.id == "tc-1"
    assert call.name == "submit_phase_output"
    assert call.arguments == {"payload": {"x": 1}, "next_phase": "EXPLORE"}


def test_from_dict_falls_back_to_arguments_field():
    """OpenAI-style providers may use `arguments` instead. Tolerate it."""
    raw = {
        "id": "tc-2",
        "name": "submit_phase_output",
        "arguments": {"payload": {"y": 2}},
    }
    call = ChatToolCall.from_dict(raw)
    assert call.arguments == {"payload": {"y": 2}}


def test_from_dict_prefers_args_when_both_present():
    """If a future provider sends BOTH, `args` (the gateway's name) wins.
    This is the safe default — the gateway is what we proxy through."""
    raw = {
        "id": "tc-3",
        "name": "submit_phase_output",
        "args": {"payload": {"from_args": True}},
        "arguments": {"payload": {"from_arguments": True}},
    }
    call = ChatToolCall.from_dict(raw)
    assert call.arguments == {"payload": {"from_args": True}}


def test_from_dict_decodes_stringified_args():
    """Some providers stringify the args even when nested inside an
    already-object outer envelope. JSON-decode rather than dropping."""
    raw = {
        "id": "tc-4",
        "name": "submit_phase_output",
        "args": '{"payload": {"z": 3}, "next_phase": "VERIFY"}',
    }
    call = ChatToolCall.from_dict(raw)
    assert call.arguments == {"payload": {"z": 3}, "next_phase": "VERIFY"}


def test_from_dict_keeps_raw_when_args_string_unparseable():
    """Unparseable string args don't crash — caller's malformed-detection
    branch handles the missing-payload case downstream."""
    raw = {
        "id": "tc-5",
        "name": "submit_phase_output",
        "args": "not-json {{",
    }
    call = ChatToolCall.from_dict(raw)
    # Falls into the `{"_raw": ...}` wrapper so the LLM's raw text is
    # preserved for diagnostic logging — but `payload` is absent, so
    # _extract_phase_output will still flag malformed.
    assert call.arguments == {"_raw": "not-json {{"}


def test_from_dict_handles_no_args_at_all():
    """A genuinely tool-call-with-no-arguments emission becomes `{}`.
    This case is now detectable by the malformed branch in turn.py."""
    raw = {"id": "tc-6", "name": "submit_phase_output"}
    call = ChatToolCall.from_dict(raw)
    assert call.arguments == {}


def test_from_dict_handles_non_dict_non_string_args():
    """Lists, numbers, etc. degrade safely to `{}`."""
    raw = {"id": "tc-7", "name": "x", "args": [1, 2, 3]}
    call = ChatToolCall.from_dict(raw)
    assert call.arguments == {}


def test_from_dict_pulls_name_from_tool_name_too():
    """OpenAI-style `tool_name` fallback."""
    raw = {"id": "tc-8", "tool_name": "alt_name", "args": {"k": "v"}}
    call = ChatToolCall.from_dict(raw)
    assert call.name == "alt_name"
    assert call.arguments == {"k": "v"}
