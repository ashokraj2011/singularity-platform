"""Tests for governed/code_context.py (architecture gap #5).

The helper is best-effort by design — every error path returns
(None, reason) so the calling turn can degrade gracefully. These
tests pin every reason string + the package_markdown key tolerance.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

import context_api_service.app.governed.code_context as code_context_mod
from context_api_service.app.governed.code_context import (
    build_code_context_for_governed_turn,
    package_markdown,
)


def _run(coro):
    return asyncio.run(coro)


def _make_poster(return_value: Any = None, raises: Exception | None = None):
    """Build an injectable _http_post that returns the given dict or
    raises the given exception."""
    async def _poster(_url, _payload, _headers, _timeout):
        if raises is not None:
            raise raises
        return return_value
    return _poster


# ── happy path ─────────────────────────────────────────────────────────────


def test_returns_package_on_success():
    poster = _make_poster({
        "success": True,
        "data": {
            "context_package_id": "ctx-123",
            "packageMarkdown": "# package content",
        },
    })
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="implement is_palindrome",
        capability_id="cap-1",
        run_context={"trace_id": "trace-1"},
        mcp_base_url="http://mcp:7100",
        mcp_bearer="tok",
        _http_post=poster,
    ))
    assert reason is None
    assert pkg is not None
    assert pkg["context_package_id"] == "ctx-123"


def test_forwards_capability_id_and_trace_id():
    """The package builder should carry capability_id + trace_id
    onto the wire so mcp-server can resolve the right repo + emit
    audit events tied to the parent run."""
    captured: list[tuple] = []

    async def _capture(url, payload, headers, timeout):
        captured.append((url, payload, headers))
        return {"success": True, "data": {"context_package_id": "x", "markdown": "y"}}

    _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id="cap-99",
        run_context={"trace_id": "trace-77"},
        mcp_base_url="http://mcp:7100",
        _http_post=_capture,
    ))
    _, payload, _ = captured[0]
    assert payload["capability_id"] == "cap-99"
    assert payload["trace_id"] == "trace-77"
    assert payload["task_text"] == "x"


def test_forwards_camelcase_trace_id_alias():
    """Some upstream callers emit traceId (camelCase). Tolerated so
    a refactor of the run_context contract doesn't silently drop
    the trace correlation."""
    captured: list[tuple] = []

    async def _capture(url, payload, headers, timeout):
        captured.append((url, payload, headers))
        return {"success": True, "data": {"context_package_id": "x"}}

    _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id=None,
        run_context={"traceId": "camel-cased"},
        mcp_base_url="http://mcp:7100",
        _http_post=_capture,
    ))
    _, payload, _ = captured[0]
    assert payload["trace_id"] == "camel-cased"


def test_sends_bearer_when_token_provided():
    captured: list[tuple] = []

    async def _capture(url, payload, headers, timeout):
        captured.append((url, payload, headers))
        return {"success": True, "data": {"context_package_id": "x"}}

    _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id=None,
        run_context=None,
        mcp_base_url="http://mcp:7100",
        mcp_bearer="secret-tok",
        _http_post=_capture,
    ))
    _, _, headers = captured[0]
    assert headers["authorization"] == "Bearer secret-tok"


def test_omits_bearer_when_no_token():
    captured: list[tuple] = []

    async def _capture(url, payload, headers, timeout):
        captured.append((url, payload, headers))
        return {"success": True, "data": {"context_package_id": "x"}}

    _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id=None,
        run_context=None,
        mcp_base_url="http://mcp:7100",
        mcp_bearer="",
        _http_post=_capture,
    ))
    _, _, headers = captured[0]
    assert "authorization" not in headers


# ── degradation reasons ────────────────────────────────────────────────────


def test_empty_task_text_short_circuits():
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="",
        capability_id="cap",
        run_context=None,
        mcp_base_url="http://mcp:7100",
    ))
    assert pkg is None
    assert "empty task_text" in (reason or "")


def test_whitespace_only_task_text_short_circuits():
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="   \n  ",
        capability_id="cap",
        run_context=None,
        mcp_base_url="http://mcp:7100",
    ))
    assert pkg is None
    assert "empty task_text" in (reason or "")


def test_missing_mcp_url_reported():
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id="cap",
        run_context=None,
        mcp_base_url="",  # explicit empty + no env
    ))
    assert pkg is None
    assert "MCP_SERVER_URL not configured" in (reason or "")


def test_transport_error_reported():
    poster = _make_poster(raises=ConnectionError("mcp down"))
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id=None,
        run_context=None,
        mcp_base_url="http://mcp:7100",
        _http_post=poster,
    ))
    assert pkg is None
    assert "transport error" in (reason or "")
    assert "mcp down" in (reason or "")


def test_identityless_code_context_uses_static_http_without_runtime_fallback():
    captured: list[tuple] = []

    async def _capture(url, payload, headers, timeout):
        captured.append((url, payload, headers))
        return {"success": True, "data": {"context_package_id": "ctx-static"}}

    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id=None,
        run_context=None,
        mcp_base_url="http://mcp:7100",
        _http_post=_capture,
    ))

    assert reason is None
    assert pkg is not None
    assert pkg["context_package_id"] == "ctx-static"
    assert captured[0][0] == "http://mcp:7100/mcp/code-context/build"


def test_runtime_code_context_fails_closed_without_http_fallback(monkeypatch):
    async def _no_runtime(*args, **kwargs):
        return None

    monkeypatch.delenv("RUNTIME_HTTP_FALLBACK_ENABLED", raising=False)
    monkeypatch.setattr(code_context_mod, "_try_laptop_code_context", _no_runtime)

    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x",
        capability_id=None,
        run_context={"user_id": "u1"},
        laptop_user_id="u1",
        mcp_base_url="http://mcp:7100",
        _http_post=_make_poster({
            "success": True,
            "data": {"context_package_id": "should-not-use-http"},
        }),
    ))

    assert pkg is None
    assert reason == "RUNTIME_NOT_CONNECTED: no runtime bridge connected for code-context"


def test_backend_success_false_reported():
    poster = _make_poster({"success": False, "error": {"code": "FOO"}})
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x", capability_id=None, run_context=None,
        mcp_base_url="http://mcp:7100", _http_post=poster,
    ))
    assert pkg is None
    assert "success=false" in (reason or "")


def test_non_dict_response_reported():
    poster = _make_poster("not a dict")
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x", capability_id=None, run_context=None,
        mcp_base_url="http://mcp:7100", _http_post=poster,
    ))
    assert pkg is None
    assert "non-dict" in (reason or "")


def test_missing_context_package_id_reported():
    """Defensive: a backend that returns success=true but no
    context_package_id is corrupt. Treat as failure rather than
    advancing with empty context."""
    poster = _make_poster({"success": True, "data": {"packageMarkdown": "x"}})
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x", capability_id=None, run_context=None,
        mcp_base_url="http://mcp:7100", _http_post=poster,
    ))
    assert pkg is None
    assert "no context_package_id" in (reason or "")


def test_missing_data_block_reported():
    poster = _make_poster({"success": True})  # no `data` key
    pkg, reason = _run(build_code_context_for_governed_turn(
        task_text="x", capability_id=None, run_context=None,
        mcp_base_url="http://mcp:7100", _http_post=poster,
    ))
    assert pkg is None
    assert "missing data block" in (reason or "")


# ── package_markdown key tolerance ─────────────────────────────────────────


def test_package_markdown_finds_first_present_key():
    """mcp-server has flipped the markdown key name between releases.
    Tolerate all three so a backend upgrade doesn't silently empty
    the prompt."""
    assert package_markdown({"packageMarkdown": "v1"}) == "v1"
    assert package_markdown({"markdown": "v2"}) == "v2"
    assert package_markdown({"text": "v3"}) == "v3"


def test_package_markdown_prefers_first_key_when_multiple_present():
    """If the backend returns multiple aliases (transition release),
    prefer packageMarkdown (the canonical name)."""
    pkg = {"packageMarkdown": "canonical", "markdown": "old", "text": "older"}
    assert package_markdown(pkg) == "canonical"


def test_package_markdown_returns_empty_when_no_recognised_key():
    assert package_markdown({"context_package_id": "x", "foo": "bar"}) == ""


def test_package_markdown_returns_empty_on_non_string_value():
    """Defensive: a backend that flips the type to a list should not
    crash the turn — we just degrade to no-package."""
    assert package_markdown({"markdown": ["chunked", "into", "list"]}) == ""


def test_package_markdown_skips_whitespace_only_value():
    """An empty/whitespace markdown is not worth injecting — the
    prompt would just gain a `{{code_context_package}}` block of
    nothing. Skip it so the no-package degradation path runs."""
    assert package_markdown({"markdown": "   \n  "}) == ""


def test_package_markdown_handles_non_dict():
    """Defensive: a future caller might forward a string by accident.
    Return "" instead of crashing."""
    assert package_markdown("string") == ""
    assert package_markdown(None) == ""  # type: ignore[arg-type]
