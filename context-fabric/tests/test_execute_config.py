from __future__ import annotations

from pathlib import Path

from context_api_service.app import execute


def test_default_mcp_invoke_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", raising=False)
    assert execute._default_mcp_invoke_timeout_sec() == 480.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "bad")
    assert execute._default_mcp_invoke_timeout_sec() == 480.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "nan")
    assert execute._default_mcp_invoke_timeout_sec() == 480.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "inf")
    assert execute._default_mcp_invoke_timeout_sec() == 480.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "0")
    assert execute._default_mcp_invoke_timeout_sec() == 480.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "1200.5")
    assert execute._default_mcp_invoke_timeout_sec() == 1200.5

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "999999")
    assert execute._default_mcp_invoke_timeout_sec() == 7200.0


def test_request_timeout_sec_accepts_camel_and_snake_case_but_bounds_values():
    assert execute._request_timeout_sec({}, default=240.0) == 240.0
    assert execute._request_timeout_sec({"timeoutSec": "30.5"}, default=240.0) == 30.5
    assert execute._request_timeout_sec({"timeout_sec": 45}, default=240.0) == 45.0
    assert execute._request_timeout_sec({"timeoutSec": "bad"}, default=240.0) == 240.0
    assert execute._request_timeout_sec({"timeoutSec": "nan"}, default=240.0) == 240.0
    assert execute._request_timeout_sec({"timeoutSec": float("inf")}, default=240.0) == 240.0
    assert execute._request_timeout_sec({"timeoutSec": 0}, default=240.0) == 240.0
    assert execute._request_timeout_sec({"timeoutSec": 999999}, default=240.0) == 7200.0


def test_agent_profile_resolve_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", raising=False)
    assert execute._agent_profile_resolve_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", "bad")
    assert execute._agent_profile_resolve_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", "nan")
    assert execute._agent_profile_resolve_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", "0")
    assert execute._agent_profile_resolve_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", "12.5")
    assert execute._agent_profile_resolve_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", "999999")
    assert execute._agent_profile_resolve_timeout_sec() == 300.0


def test_tool_discovery_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC", raising=False)
    assert execute._tool_discovery_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC", "bad")
    assert execute._tool_discovery_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC", "nan")
    assert execute._tool_discovery_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC", "0")
    assert execute._tool_discovery_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC", "12.5")
    assert execute._tool_discovery_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC", "999999")
    assert execute._tool_discovery_timeout_sec() == 300.0


def test_prompt_composer_compose_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_PROMPT_COMPOSER_COMPOSE_TIMEOUT_SEC", raising=False)
    assert execute._prompt_composer_compose_timeout_sec() == 60.0

    monkeypatch.setenv("CONTEXT_FABRIC_PROMPT_COMPOSER_COMPOSE_TIMEOUT_SEC", "bad")
    assert execute._prompt_composer_compose_timeout_sec() == 60.0

    monkeypatch.setenv("CONTEXT_FABRIC_PROMPT_COMPOSER_COMPOSE_TIMEOUT_SEC", "nan")
    assert execute._prompt_composer_compose_timeout_sec() == 60.0

    monkeypatch.setenv("CONTEXT_FABRIC_PROMPT_COMPOSER_COMPOSE_TIMEOUT_SEC", "0")
    assert execute._prompt_composer_compose_timeout_sec() == 60.0

    monkeypatch.setenv("CONTEXT_FABRIC_PROMPT_COMPOSER_COMPOSE_TIMEOUT_SEC", "12.5")
    assert execute._prompt_composer_compose_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_PROMPT_COMPOSER_COMPOSE_TIMEOUT_SEC", "999999")
    assert execute._prompt_composer_compose_timeout_sec() == 300.0


def test_memory_history_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_MEMORY_HISTORY_TIMEOUT_SEC", raising=False)
    assert execute._memory_history_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_HISTORY_TIMEOUT_SEC", "bad")
    assert execute._memory_history_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_HISTORY_TIMEOUT_SEC", "nan")
    assert execute._memory_history_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_HISTORY_TIMEOUT_SEC", "0")
    assert execute._memory_history_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_HISTORY_TIMEOUT_SEC", "12.5")
    assert execute._memory_history_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_HISTORY_TIMEOUT_SEC", "999999")
    assert execute._memory_history_timeout_sec() == 300.0


def test_event_subscriber_stop_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC", raising=False)
    assert execute._event_subscriber_stop_timeout_sec() == 1.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC", "bad")
    assert execute._event_subscriber_stop_timeout_sec() == 1.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC", "nan")
    assert execute._event_subscriber_stop_timeout_sec() == 1.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC", "0")
    assert execute._event_subscriber_stop_timeout_sec() == 1.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC", "12.5")
    assert execute._event_subscriber_stop_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC", "999999")
    assert execute._event_subscriber_stop_timeout_sec() == 60.0


def test_event_subscriber_trailing_grace_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", raising=False)
    assert execute._event_subscriber_trailing_grace_sec() == 0.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", "bad")
    assert execute._event_subscriber_trailing_grace_sec() == 0.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", "nan")
    assert execute._event_subscriber_trailing_grace_sec() == 0.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", "-1")
    assert execute._event_subscriber_trailing_grace_sec() == 0.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", "0")
    assert execute._event_subscriber_trailing_grace_sec() == 0.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", "12.5")
    assert execute._event_subscriber_trailing_grace_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC", "999999")
    assert execute._event_subscriber_trailing_grace_sec() == 60.0


def test_event_subscriber_drain_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC", raising=False)
    assert execute._event_subscriber_drain_timeout_sec() == 2.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC", "bad")
    assert execute._event_subscriber_drain_timeout_sec() == 2.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC", "nan")
    assert execute._event_subscriber_drain_timeout_sec() == 2.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC", "0")
    assert execute._event_subscriber_drain_timeout_sec() == 2.0

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC", "12.5")
    assert execute._event_subscriber_drain_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC", "999999")
    assert execute._event_subscriber_drain_timeout_sec() == 60.0


def test_execute_event_subscriber_waits_use_bounded_helpers():
    source = Path(__file__).resolve().parents[1] / "services/context_api_service/app/execute.py"
    text = source.read_text()

    assert "CONTEXT_FABRIC_EVENT_SUBSCRIBER_STOP_TIMEOUT_SEC" in text
    assert "CONTEXT_FABRIC_EVENT_SUBSCRIBER_TRAILING_GRACE_SEC" in text
    assert "CONTEXT_FABRIC_EVENT_SUBSCRIBER_DRAIN_TIMEOUT_SEC" in text
    assert "asyncio.wait_for(subscriber_task, timeout=_event_subscriber_stop_timeout_sec())" in text
    assert "asyncio.sleep(_event_subscriber_trailing_grace_sec())" in text
    assert "asyncio.wait_for(subscriber_task, timeout=_event_subscriber_drain_timeout_sec())" in text
    assert "asyncio.wait_for(subscriber_task, timeout=1.0)" not in text
    assert "asyncio.wait_for(subscriber_task, timeout=2.0)" not in text
    assert "asyncio.sleep(0.5)" not in text


def test_deep_reasoning_budget_env_is_bounded(monkeypatch):
    monkeypatch.delenv("DEEP_REASONING_BUDGET_TOKENS", raising=False)
    assert execute._deep_reasoning_budget_tokens() == 0

    monkeypatch.setenv("DEEP_REASONING_BUDGET_TOKENS", "bad")
    assert execute._deep_reasoning_budget_tokens() == 0

    monkeypatch.setenv("DEEP_REASONING_BUDGET_TOKENS", "-1")
    assert execute._deep_reasoning_budget_tokens() == 0

    monkeypatch.setenv("DEEP_REASONING_BUDGET_TOKENS", "8192")
    assert execute._deep_reasoning_budget_tokens() == 8192

    monkeypatch.setenv("DEEP_REASONING_BUDGET_TOKENS", "999999")
    assert execute._deep_reasoning_budget_tokens() == 32_768
