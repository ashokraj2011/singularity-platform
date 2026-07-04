from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from context_api_service.app.response_json import (
    UpstreamJsonError,
    response_json,
    response_json_object,
    response_snippet,
)


def _response(body: str, status_code: int = 200) -> httpx.Response:
    return httpx.Response(status_code=status_code, content=body.encode("utf-8"))


def test_response_json_object_accepts_objects():
    assert response_json_object(_response('{"ok": true}'), "unit").get("ok") is True


def test_response_json_rejects_invalid_json_with_snippet():
    with pytest.raises(UpstreamJsonError) as exc:
        response_json(_response("Internal Server Error", status_code=200), "unit upstream")
    assert exc.value.source == "unit upstream"
    assert exc.value.status_code == 200
    assert exc.value.snippet == "Internal Server Error"
    assert "invalid JSON" in str(exc.value)


def test_response_json_object_rejects_arrays():
    with pytest.raises(UpstreamJsonError) as exc:
        response_json_object(_response("[1, 2, 3]"), "array upstream")
    assert "invalid JSON object" in str(exc.value)


def test_response_snippet_compacts_whitespace():
    assert response_snippet(" one\n\n two\t three ", 20) == "one two three"


def test_runtime_boundary_files_use_shared_response_parser():
    root = Path(__file__).resolve().parents[1] / "services" / "context_api_service" / "app"
    for relative in [
        "laptop_bridge.py",
        "execute_modules/runtime_resolver.py",
        "execute_modules/prompt_context.py",
        "execute_modules/mcp_dispatcher.py",
        "execute_modules/event_collector.py",
        "git_broker.py",
        "governed/llm_client.py",
        "governed/prompt_resolver.py",
        "governed/policy_loader.py",
        "governed/model_catalog.py",
        "governed/dispatch.py",
        "governed/code_context.py",
        "main.py",
        "execute.py",
        "internal_mcp.py",
        "healthz_strict.py",
    ]:
        source = (root / relative).read_text()
        assert ".json()" not in source, f"{relative} should parse upstream responses through response_json"
