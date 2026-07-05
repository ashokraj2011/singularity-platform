import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi import Response

from context_api_service.app import main as context_main
from context_api_service.app.main import gateway_messages_from_compiled


def test_gateway_messages_do_not_duplicate_current_user_turn():
    messages = gateway_messages_from_compiled(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "same task"},
        ],
        "same task",
    )

    assert messages == [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "same task"},
    ]


def test_gateway_messages_append_user_turn_when_memory_does_not_include_it():
    messages = gateway_messages_from_compiled(
        [{"role": "assistant", "content": "previous answer"}],
        "new task",
    )

    assert messages[-1] == {"role": "user", "content": "new task"}


@pytest.mark.parametrize(
    ("env_name", "helper_name"),
    [
        ("CONTEXT_FABRIC_CHAT_RESPOND_MCP_TIMEOUT_SEC", "chat_respond_mcp_timeout_sec"),
        ("CONTEXT_FABRIC_CHAT_RESPOND_SUMMARY_TIMEOUT_SEC", "chat_respond_summary_timeout_sec"),
    ],
)
def test_chat_respond_timeout_env_is_bounded(monkeypatch, env_name, helper_name):
    helper = getattr(context_main, helper_name)

    monkeypatch.delenv(env_name, raising=False)
    assert helper() == 180.0

    monkeypatch.setenv(env_name, "bad")
    assert helper() == 180.0

    monkeypatch.setenv(env_name, "nan")
    assert helper() == 180.0

    monkeypatch.setenv(env_name, "0")
    assert helper() == 180.0

    monkeypatch.setenv(env_name, "12.5")
    assert helper() == 12.5

    monkeypatch.setenv(env_name, "999999")
    assert helper() == 3600.0


class FakeChatMcpAsyncClient:
    timeouts: list[float] = []
    posts: list[tuple[str, dict[str, object], dict[str, str]]] = []

    def __init__(self, timeout: float):
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url: str, **kwargs):
        self.posts.append((url, kwargs.get("json"), kwargs.get("headers")))
        return httpx.Response(
            200,
            json={
                "data": {
                    "finalResponse": "ok",
                    "modelUsage": {"provider": "mock", "model": "mock-fast"},
                    "tokensUsed": {"input": 2, "output": 3},
                    "metrics": {"mcpLatencyMs": 4},
                    "correlation": {"mcpInvocationId": "call-1"},
                }
            },
            request=httpx.Request("POST", url),
        )


def test_chat_respond_routes_mcp_with_configured_timeout(monkeypatch):
    get_calls: list[tuple[str, float]] = []
    post_calls: list[tuple[str, dict[str, object], float]] = []
    FakeChatMcpAsyncClient.timeouts = []
    FakeChatMcpAsyncClient.posts = []

    async def fake_get_json(url: str, timeout: float = 60.0):
        get_calls.append((url, timeout))
        return {"messages_since_summary": 8, "total_tokens": 10}

    async def fake_post_json(url: str, payload: dict[str, object], timeout: float = 120.0):
        post_calls.append((url, payload, timeout))
        if url.endswith("/context/compile"):
            return {
                "context_package_id": "pkg-1",
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "hello"},
                ],
                "optimization": {
                    "mode": "compact",
                    "raw_input_tokens": 10,
                    "optimized_input_tokens": 5,
                    "tokens_saved": 5,
                    "percent_saved": 50,
                },
            }
        if url.endswith("/metrics/token-savings"):
            return {"id": "metrics-1"}
        return {"ok": True}

    monkeypatch.setenv("CONTEXT_FABRIC_CHAT_RESPOND_MCP_TIMEOUT_SEC", "34.5")
    monkeypatch.setenv("CONTEXT_FABRIC_CHAT_RESPOND_SUMMARY_TIMEOUT_SEC", "12.5")
    monkeypatch.setattr(context_main, "check_execute_service_token", lambda _token: None)
    monkeypatch.setattr(context_main, "get_json", fake_get_json)
    monkeypatch.setattr(context_main, "post_json", fake_post_json)
    monkeypatch.setattr(context_main.httpx, "AsyncClient", FakeChatMcpAsyncClient)
    monkeypatch.setattr(context_main.settings, "context_memory_url", "http://memory.local")
    monkeypatch.setattr(context_main.settings, "metrics_ledger_url", "http://metrics.local")
    monkeypatch.setattr(context_main.settings, "mcp_default_base_url", "http://mcp.local")
    monkeypatch.setattr(context_main.settings, "mcp_default_bearer_token", "mcp-token")
    monkeypatch.setattr(context_main.settings, "chat_respond_model_alias", "")

    result = asyncio.run(
        context_main.chat_respond(
            context_main.ChatRespondRequest(session_id="s1", message="hello", summarization={"force": True}),
            response=Response(),
            x_service_token=None,
        )
    )

    assert result.response == "ok"
    assert result.metrics_run_id == "metrics-1"
    assert get_calls == [("http://memory.local/memory/messages/s1/stats", 60.0)]
    summary_call = next(call for call in post_calls if call[0].endswith("/memory/summaries/update"))
    assert summary_call[2] == 12.5
    assert FakeChatMcpAsyncClient.timeouts == [34.5]
    assert FakeChatMcpAsyncClient.posts[0][0] == "http://mcp.local/mcp/invoke"
    assert FakeChatMcpAsyncClient.posts[0][2]["authorization"] == "Bearer mcp-token"
    assert FakeChatMcpAsyncClient.posts[0][1]["limits"]["timeoutSec"] == 34.5


def test_chat_respond_uses_bounded_timeout_helpers():
    source_path = Path(__file__).resolve().parents[1] / "services/context_api_service/app/main.py"
    source = source_path.read_text()

    assert "CONTEXT_FABRIC_CHAT_RESPOND_MCP_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_CHAT_RESPOND_SUMMARY_TIMEOUT_SEC" in source
    assert "httpx.AsyncClient(timeout=mcp_timeout_sec)" in source
    assert "timeout=180.0" not in source
