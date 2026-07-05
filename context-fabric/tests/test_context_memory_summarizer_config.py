from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from context_memory_service.app import summarizer


def test_context_memory_summarizer_mcp_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", raising=False)
    assert summarizer.summarizer_mcp_timeout_sec() == 120.0

    monkeypatch.setenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", "bad")
    assert summarizer.summarizer_mcp_timeout_sec() == 120.0

    monkeypatch.setenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", "nan")
    assert summarizer.summarizer_mcp_timeout_sec() == 120.0

    monkeypatch.setenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", "0")
    assert summarizer.summarizer_mcp_timeout_sec() == 120.0

    monkeypatch.setenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", "12.5")
    assert summarizer.summarizer_mcp_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", "999999")
    assert summarizer.summarizer_mcp_timeout_sec() == 3600.0


class FakeSummarizerAsyncClient:
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
                    "finalResponse": (
                        '{"current_goal":"Ship it","important_context":["ctx"],'
                        '"decisions_made":[],"requirements":[],"constraints":[],'
                        '"open_questions":[],"user_preferences":[],"technical_design":[],'
                        '"changes_done":[],"next_best_actions":[],"durable_learning":[]}'
                    )
                }
            },
            request=httpx.Request("POST", url),
        )


def test_summarizer_routes_mcp_with_configured_timeout(monkeypatch):
    FakeSummarizerAsyncClient.timeouts = []
    FakeSummarizerAsyncClient.posts = []

    async def fake_resolve_prompts(_schema_keys_text: str, _compact: str):
        return "system", "summarize"

    monkeypatch.setenv("CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC", "45.5")
    monkeypatch.setattr(summarizer, "_resolve_summarizer_prompts", fake_resolve_prompts)
    monkeypatch.setattr(summarizer.httpx, "AsyncClient", FakeSummarizerAsyncClient)
    monkeypatch.setattr(summarizer.settings, "mcp_server_url", "http://mcp.local")
    monkeypatch.setattr(summarizer.settings, "mcp_bearer_token", "mcp-token")
    monkeypatch.setattr(summarizer.settings, "summarizer_model_alias", "mock-fast")

    result = asyncio.run(
        summarizer.summarize_with_llm(
            [
                {"role": "user", "content": "please summarize"},
                {"role": "assistant", "content": "working"},
            ],
            agent_id="agent-1",
        )
    )

    assert result["current_goal"] == "Ship it"
    assert FakeSummarizerAsyncClient.timeouts == [45.5]
    assert FakeSummarizerAsyncClient.posts[0][0] == "http://mcp.local/mcp/invoke"
    payload = FakeSummarizerAsyncClient.posts[0][1]
    assert payload["limits"]["timeoutSec"] == 45.5
    assert payload["modelConfig"]["modelAlias"] == "mock-fast"
    assert FakeSummarizerAsyncClient.posts[0][2]["authorization"] == "Bearer mcp-token"


def test_context_memory_summarizer_uses_bounded_timeout_helper():
    source_path = Path(__file__).resolve().parents[1] / "services/context_memory_service/app/summarizer.py"
    source = source_path.read_text()

    assert "CONTEXT_MEMORY_SUMMARIZER_MCP_TIMEOUT_SEC" in source
    assert "timeoutSec\": timeout_sec" in source
    assert "httpx.AsyncClient(timeout=timeout_sec)" in source
    assert "timeoutSec\": 120" not in source
    assert "httpx.AsyncClient(timeout=120.0)" not in source
