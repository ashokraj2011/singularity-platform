from __future__ import annotations

import asyncio
from pathlib import Path

from context_api_service.app.execute_modules import memory_context


def test_memory_write_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", raising=False)
    assert memory_context.memory_write_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", "bad")
    assert memory_context.memory_write_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", "nan")
    assert memory_context.memory_write_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", "0")
    assert memory_context.memory_write_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", "12.5")
    assert memory_context.memory_write_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", "999999")
    assert memory_context.memory_write_timeout_sec() == 300.0


def test_memory_summary_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", raising=False)
    assert memory_context.memory_summary_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", "bad")
    assert memory_context.memory_summary_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", "nan")
    assert memory_context.memory_summary_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", "0")
    assert memory_context.memory_summary_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", "12.5")
    assert memory_context.memory_summary_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", "999999")
    assert memory_context.memory_summary_timeout_sec() == 300.0


class FakeAsyncClient:
    timeouts: list[float] = []
    posts: list[tuple[str, dict | None, float | None]] = []

    def __init__(self, timeout: float):
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url: str, **kwargs):
        self.posts.append((url, kwargs.get("json"), kwargs.get("timeout")))
        return object()


def test_persist_turn_uses_configured_memory_timeouts(monkeypatch):
    FakeAsyncClient.timeouts = []
    FakeAsyncClient.posts = []
    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC", "12.5")
    monkeypatch.setenv("CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC", "30.5")
    monkeypatch.setattr(memory_context.settings, "context_memory_url", "http://memory.local")
    monkeypatch.setattr(memory_context.httpx, "AsyncClient", FakeAsyncClient)

    asyncio.run(
        memory_context.persist_turn_and_maybe_summarise(
            session_id="session-1",
            agent_id="agent-1",
            user_message="hello",
            assistant_response="done",
            limits={"summaryEveryMessages": 9},
        )
    )

    assert FakeAsyncClient.timeouts == [12.5]
    assert [url for url, _, _ in FakeAsyncClient.posts] == [
        "http://memory.local/memory/messages",
        "http://memory.local/memory/messages",
        "http://memory.local/memory/summaries/update",
    ]
    assert FakeAsyncClient.posts[0][1] == {
        "session_id": "session-1",
        "agent_id": "agent-1",
        "role": "user",
        "content": "hello",
    }
    assert FakeAsyncClient.posts[1][1] == {
        "session_id": "session-1",
        "agent_id": "agent-1",
        "role": "assistant",
        "content": "done",
    }
    assert FakeAsyncClient.posts[2][1] == {
        "session_id": "session-1",
        "agent_id": "agent-1",
        "force": False,
        "min_messages_since_last_summary": 9,
    }
    assert FakeAsyncClient.posts[2][2] == 30.5


def test_memory_context_uses_bounded_timeout_constants():
    source = Path("services/context_api_service/app/execute_modules/memory_context.py").read_text()
    assert "from ..env_config import bounded_float_value" in source
    assert "CONTEXT_FABRIC_MEMORY_WRITE_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_MEMORY_SUMMARY_TIMEOUT_SEC" in source
    assert "httpx.AsyncClient(timeout=memory_write_timeout_sec())" in source
    assert "timeout=memory_summary_timeout_sec()" in source
    assert "httpx.AsyncClient(timeout=10.0)" not in source
    assert "timeout=20.0" not in source
