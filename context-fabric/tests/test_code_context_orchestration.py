"""
M52 Slice C — Context Fabric orchestration tests.

Verifies that `_build_code_context_package` behaves correctly under the
four conditions the spec calls out:
  1. MCP returns a well-formed package → returned dict + no warning.
  2. MCP returns HTTP 5xx → graceful (None, warning) with no exception.
  3. MCP request times out → graceful (None, warning).
  4. MCP returns success=false → graceful (None, warning).

The end-to-end "is this called only for dev stages" check is asserted by
the existing `_classify_stage_role` test plus a direct import-time check
on `execute.py`'s call-site source.
"""
from __future__ import annotations
from types import SimpleNamespace
from typing import Any

import asyncio
import inspect
import pytest
import httpx

from context_api_service.app.execute import (
    _build_code_context_package,
    _classify_stage_role,
)
from context_api_service.app import execute as execute_module
# M73 — `_build_code_context_package` and its `_post` collaborator now live in
# execute_modules.prompt_context. Tests must patch the canonical module so the
# stub is observed by the function's intra-module call (`await _post(...)`).
from context_api_service.app.execute_modules import prompt_context as prompt_context_module


def make_req(task: str = "Add validateEmail", capability_id: str = "cap-1") -> SimpleNamespace:
    return SimpleNamespace(
        task=task,
        run_context=SimpleNamespace(capability_id=capability_id),
    )


# ── 1. Happy path ─────────────────────────────────────────────────────────

def test_returns_package_when_mcp_responds_with_success(monkeypatch: pytest.MonkeyPatch):
    fake_pkg = {
        "context_package_id": "ctx-good-1",
        "task_intent": {"kind": "code_modification", "summary": "Add validateEmail"},
        "target_symbols": [],
        "editable_slices": [
            {"file": "src/x.ts", "symbol": "x", "start_line": 1, "end_line": 2,
             "content": "x", "token_count": 1, "content_hash": "a" * 64}
        ],
        "dependency_slices": [],
        "test_slices": [],
        "excluded_context": [],
        "optimization": {"raw_estimate": 100, "optimized_estimate": 1, "tokens_saved": 99, "percent_saved": 99.0},
    }

    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers: Any = None) -> dict:
        assert url.endswith("/mcp/code-context/build")
        assert payload["task_text"] == "Add validateEmail"
        return {"success": True, "data": fake_pkg}

    monkeypatch.setattr(prompt_context_module, "_post", fake_post)

    pkg, warning = asyncio.run(_build_code_context_package(
        "http://mcp:7100", "tok", make_req(), trace_id="t1",
    ))
    assert warning is None
    assert pkg is not None
    assert pkg["context_package_id"] == "ctx-good-1"


# ── 2. HTTP 5xx ────────────────────────────────────────────────────────────

def test_returns_none_with_warning_on_http_error(monkeypatch: pytest.MonkeyPatch):
    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers: Any = None) -> dict:
        request = httpx.Request("POST", url)
        response = httpx.Response(503, request=request, text="upstream busy")
        raise httpx.HTTPStatusError("503", request=request, response=response)

    monkeypatch.setattr(prompt_context_module, "_post", fake_post)

    pkg, warning = asyncio.run(_build_code_context_package(
        "http://mcp:7100", "tok", make_req(), trace_id=None,
    ))
    assert pkg is None
    assert warning is not None
    assert "HTTP 503" in warning


# ── 3. Transport / timeout ────────────────────────────────────────────────

def test_returns_none_with_warning_on_transport_error(monkeypatch: pytest.MonkeyPatch):
    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers: Any = None) -> dict:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(prompt_context_module, "_post", fake_post)

    pkg, warning = asyncio.run(_build_code_context_package(
        "http://mcp:7100", "tok", make_req(), trace_id=None,
    ))
    assert pkg is None
    assert warning is not None
    assert "transport error" in warning


# ── 4. Backend returns success=false ──────────────────────────────────────

def test_returns_none_with_warning_on_backend_failure(monkeypatch: pytest.MonkeyPatch):
    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers: Any = None) -> dict:
        return {"success": False, "error": "ast index empty"}

    monkeypatch.setattr(prompt_context_module, "_post", fake_post)

    pkg, warning = asyncio.run(_build_code_context_package(
        "http://mcp:7100", "tok", make_req(), trace_id=None,
    ))
    assert pkg is None
    assert warning is not None
    assert "success=false" in warning


# ── 5. Stage-role gating: the call-site is guarded by is_dev_stage ───────

def test_orchestration_call_site_gates_on_dev_stage():
    """
    Static assertion: the compose flow only invokes _build_code_context_package
    inside an `is_dev_stage` branch. Prevents accidental QA/PLAN invocation in
    later refactors. Mirrors the M44 hardening contract test style.
    """
    src = inspect.getsource(execute_module)
    # The two lines must appear in this order: the dev-stage detection then
    # the budgeter call below it, within a few lines.
    dev_idx = src.find("is_dev_stage, _is_qa_stage = _classify_stage_role(req)")
    call_idx = src.find("await _build_code_context_package(")
    assert dev_idx != -1, "M52 dev-stage classifier call missing"
    assert call_idx != -1, "M52 budgeter invocation missing"
    assert dev_idx < call_idx, "budgeter must be called AFTER stage classification"
    # And it must be inside a conditional that references is_dev_stage.
    snippet = src[dev_idx:call_idx]
    assert "if is_dev_stage" in snippet, "budgeter call must be inside an `if is_dev_stage` guard"


def test_classify_role_already_handles_dev_qa_split():
    """Sanity: the existing M43 classifier still does what we depend on.
    Uses the full fixture shape (vars/limits/allow_autonomous_mutation)
    because `_classify_stage_role` reads those — the budgeter's own
    `make_req` is intentionally minimal because the helper only reads
    `task` and `run_context.capability_id`."""
    plain = SimpleNamespace(
        task="implement validateEmail",
        run_context=SimpleNamespace(capability_id="c"),
        vars={},
        allow_autonomous_mutation=False,
        limits={},
    )
    assert _classify_stage_role(plain) == (False, False)
    dev_req = SimpleNamespace(
        task="x",
        run_context=SimpleNamespace(capability_id="c"),
        vars={"agentRole": "DEVELOPER"},
        allow_autonomous_mutation=False,
        limits={},
    )
    assert _classify_stage_role(dev_req) == (True, False)
