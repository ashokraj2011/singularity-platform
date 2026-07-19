from __future__ import annotations

import asyncio

import pytest

from services.context_api_service.app.governed.direct_llm_client import (
    call_direct_chat,
    direct_route_allowed,
    is_context_fabric_direct_route,
    requested_direct_route,
)
from services.context_api_service.app.governed.llm_client import LLMGatewayError


def test_direct_route_requires_explicit_context_fabric_value() -> None:
    """Only explicit route values count. This is about VALUE PARSING and is
    unaffected by whether the direct hatch is open."""
    assert requested_direct_route({"llm_route": "context_fabric_direct"}) is True
    assert requested_direct_route({"llmRoute": "direct-context-fabric"}) is True
    assert requested_direct_route({"llm_route": "workgraph"}) is False
    assert requested_direct_route({}) is False


def test_requesting_the_direct_route_is_not_enough(monkeypatch: pytest.MonkeyPatch) -> None:
    """W2-4: the direct route bypasses the gateway entirely -- no single-source
    enforcement, no task tag, no audit line, no cost attribution. Asking for it
    no longer grants it; the caller falls through to the gateway instead."""
    monkeypatch.delenv("CF_ALLOW_DIRECT_LLM", raising=False)
    assert is_context_fabric_direct_route({"llm_route": "context_fabric_direct"}) is False


def test_the_hatch_can_be_opened(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_ALLOW_DIRECT_LLM", "true")
    assert is_context_fabric_direct_route({"llm_route": "context_fabric_direct"}) is True
    # Opening the hatch must not promote a node that never asked for it.
    assert is_context_fabric_direct_route({"llm_route": "workgraph"}) is False
    assert is_context_fabric_direct_route({}) is False


def test_the_hatch_is_read_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Read at call time, so an operator can close the bypass without a restart."""
    monkeypatch.setenv("CF_ALLOW_DIRECT_LLM", "true")
    assert direct_route_allowed() is True
    monkeypatch.setenv("CF_ALLOW_DIRECT_LLM", "false")
    assert direct_route_allowed() is False


def test_direct_egress_is_blocked_even_if_a_call_site_forgets_the_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defence in depth: a future caller that skips the predicate must still not
    be able to open a provider socket."""
    monkeypatch.delenv("CF_ALLOW_DIRECT_LLM", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    with pytest.raises(LLMGatewayError, match="disabled"):
        asyncio.run(call_direct_chat(
            messages=[{"role": "user", "content": "hello"}],
            tools=None,
            model_alias="claude",
            run_context={
                "llm_route": "context_fabric_direct",
                "direct_llm": {"provider": "anthropic", "model": "claude-x"},
            },
        ))


def test_mock_direct_call_does_not_need_gateway_or_provider_key() -> None:
    response = asyncio.run(call_direct_chat(
        messages=[{"role": "user", "content": "validate this document"}],
        tools=[{"name": "submit_phase_output", "input_schema": {"type": "object"}}],
        model_alias="mock-fast",
        run_context={
            "llm_route": "context_fabric_direct",
            "direct_llm": {"provider": "mock", "model": "mock-fast"},
        },
    ))
    assert response.provider == "mock"
    assert response.tool_calls[0].name == "submit_phase_output"


def test_direct_provider_rejects_unapproved_credential_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # The hatch must be open to reach the credential check at all; this test is
    # about the allowlist, which still applies once direct egress is permitted.
    monkeypatch.setenv("CF_ALLOW_DIRECT_LLM", "true")
    monkeypatch.setenv("CONTEXT_FABRIC_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS", "ANTHROPIC_API_KEY")
    monkeypatch.setenv("MY_UNSAFE_PROVIDER_KEY", "secret")
    with pytest.raises(LLMGatewayError, match="not allowed"):
        asyncio.run(call_direct_chat(
            messages=[{"role": "user", "content": "hello"}],
            tools=None,
            model_alias="gpt-4o-mini",
            run_context={
                "llm_route": "context_fabric_direct",
                "direct_llm": {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "credential_env": "MY_UNSAFE_PROVIDER_KEY",
                },
            },
        ))


def test_direct_provider_rejects_copilot_cli_alias() -> None:
    with pytest.raises(LLMGatewayError, match="Copilot is available only through"):
        asyncio.run(call_direct_chat(
            messages=[{"role": "user", "content": "implement this change"}],
            tools=None,
            model_alias="copilot",
            run_context={
                "llm_route": "context_fabric_direct",
                "direct_llm": {"provider": "copilot", "model": "gpt-4o"},
            },
        ))
