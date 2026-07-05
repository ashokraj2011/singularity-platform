from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from context_api_service.app.execute_modules import prompt_context


def test_context_compile_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", raising=False)
    assert prompt_context.context_compile_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", "bad")
    assert prompt_context.context_compile_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", "nan")
    assert prompt_context.context_compile_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", "0")
    assert prompt_context.context_compile_timeout_sec() == 20.0

    monkeypatch.setenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", "12.5")
    assert prompt_context.context_compile_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", "999999")
    assert prompt_context.context_compile_timeout_sec() == 300.0


def test_code_context_build_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", raising=False)
    assert prompt_context.code_context_build_timeout_sec() == 45.0

    monkeypatch.setenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", "bad")
    assert prompt_context.code_context_build_timeout_sec() == 45.0

    monkeypatch.setenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", "nan")
    assert prompt_context.code_context_build_timeout_sec() == 45.0

    monkeypatch.setenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", "0")
    assert prompt_context.code_context_build_timeout_sec() == 45.0

    monkeypatch.setenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", "12.5")
    assert prompt_context.code_context_build_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", "999999")
    assert prompt_context.code_context_build_timeout_sec() == 3600.0


def test_context_compile_uses_configured_timeout():
    source = Path("services/context_api_service/app/execute_modules/prompt_context.py").read_text()
    assert "from ..env_config import bounded_float_value" in source
    assert "CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC" in source
    assert "timeout=code_context_build_timeout_sec()" in source
    assert "timeout=context_compile_timeout_sec()" in source
    assert "timeout=45.0" not in source
    assert "timeout=20.0" not in source


def test_build_code_context_package_passes_bounded_timeout(monkeypatch):
    captured: dict = {}

    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers=None) -> dict:
        captured["url"] = url
        captured["payload"] = payload
        captured["timeout"] = timeout
        captured["headers"] = headers
        return {
            "success": True,
            "data": {
                "context_package_id": "ctx-1",
                "selected_files": ["src/app.ts"],
            },
        }

    monkeypatch.setenv("CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC", "12.5")
    monkeypatch.setattr(prompt_context, "_post", fake_post)
    req = SimpleNamespace(
        task="Add validation",
        run_context=SimpleNamespace(capability_id="cap-1"),
    )

    package, warning = asyncio.run(
        prompt_context.build_code_context_package(
            mcp_base_url="http://mcp.local/",
            mcp_token="mcp-token",
            req=req,
            trace_id="trace-1",
        )
    )

    assert warning is None
    assert package == {"context_package_id": "ctx-1", "selected_files": ["src/app.ts"]}
    assert captured["url"] == "http://mcp.local/mcp/code-context/build"
    assert captured["timeout"] == 12.5
    assert captured["headers"] == {"authorization": "Bearer mcp-token"}
    assert captured["payload"] == {
        "task_text": "Add validation",
        "max_token_budget": 7000,
        "include_tests": True,
        "trace_id": "trace-1",
        "capability_id": "cap-1",
    }


def test_compile_execute_context_passes_bounded_timeout(monkeypatch):
    captured: dict = {}

    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers=None) -> dict:
        captured["url"] = url
        captured["payload"] = payload
        captured["timeout"] = timeout
        captured["headers"] = headers
        return {
            "messages": [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": "user prompt"},
            ],
            "optimization": {"mode": "medium"},
        }

    monkeypatch.setenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", "12.5")
    monkeypatch.setattr(prompt_context.settings, "context_memory_url", "http://memory.local")
    monkeypatch.setattr(prompt_context, "_post", fake_post)

    history, user_message, system_prompt, optimization, warnings = asyncio.run(
        prompt_context.compile_execute_context(
            session_id="session-1",
            agent_id="agent-1",
            user_message="hello",
            system_prompt="system",
            context_policy={"maxContextTokens": 1200},
            model_overrides={"modelAlias": "fast"},
            limits={"maxPromptChars": 2000},
        )
    )

    assert history == [{"role": "system", "content": "system prompt"}]
    assert user_message == "user prompt"
    assert system_prompt is None
    assert optimization == {"mode": "medium"}
    assert warnings == []
    assert captured["url"] == "http://memory.local/context/compile"
    assert captured["timeout"] == 12.5
    assert captured["headers"] is None
    assert captured["payload"]["session_id"] == "session-1"
    assert captured["payload"]["agent_id"] == "agent-1"
    assert captured["payload"]["model"] == "fast"
