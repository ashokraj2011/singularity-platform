from __future__ import annotations

import asyncio

import pytest

from services.context_api_service.app.governed.direct_llm_client import (
    call_direct_chat,
    is_context_fabric_direct_route,
)
from services.context_api_service.app.governed.llm_client import LLMGatewayError


def test_direct_route_requires_explicit_context_fabric_value() -> None:
    assert is_context_fabric_direct_route({"llm_route": "context_fabric_direct"}) is True
    assert is_context_fabric_direct_route({"llmRoute": "direct-context-fabric"}) is True
    assert is_context_fabric_direct_route({"llm_route": "workgraph"}) is False
    assert is_context_fabric_direct_route({}) is False


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
