"""
Layered world model — the CF side of the slice fetch and the role ladder.

The load-bearing property is that NO failure mode leaves a run with less
grounding than it has today:

  slice works, views built       → world model + role views
  slice works, no views built    → world model alone (today's bytes)
  slice endpoint unreachable     → fall back to the capability-wide fetch
  parent capability (no model)   → views alone, and NO wasted fallback fetch

These are pinned here because every one of them is a silent degradation: a run
with the wrong grounding still completes, it just does worse work.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from context_api_service.app import execute as execute_mod
from context_api_service.app.execute_modules import prompt_context


def _client_returning(handler):
    """Patch httpx.AsyncClient so the fetch sees `handler`'s response."""

    class _FakeClient:
        def __init__(self, *_a, **_kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return False

        async def get(self, url, params=None):
            return handler(url, params or {})

    return _FakeClient


def _json_response(payload, status=200, url="http://rt/x"):
    return httpx.Response(status, json=payload, request=httpx.Request("GET", url))


def _fetch(monkeypatch, handler, **kwargs):
    monkeypatch.setattr(prompt_context.httpx, "AsyncClient", _client_returning(handler))
    return asyncio.run(
        prompt_context.fetch_capability_world_model_slice("http://rt", "cap-1", 3.0, **kwargs)
    )


# ── the happy path ───────────────────────────────────────────────────────────
def test_slice_returns_world_model_and_views(monkeypatch):
    captured = {}

    def handler(url, params):
        captured["url"] = url
        captured["params"] = params
        return _json_response(
            {
                "success": True,
                "data": {
                    "capabilityId": "cap-1",
                    "worldModel": {"capabilityId": "cap-1", "primaryLanguage": "ts"},
                    "views": [
                        {"kind": "core_summary", "title": "Core", "contentMd": "core text"},
                        {"kind": "development", "title": "Dev", "contentMd": "dev text"},
                    ],
                },
            }
        )

    wm, views, warning = _fetch(monkeypatch, handler, role="developer", task="add a migration")

    assert warning is None
    assert wm and wm["capabilityId"] == "cap-1"
    assert [v["kind"] for v in views] == ["core_summary", "development"]
    # The FULL url, not just the suffix: agent-runtime mounts everything under
    # /api/v1, and a suffix-only assertion is exactly what let this endpoint be
    # requested at the wrong path — 404ing silently — since it was written.
    assert captured["url"] == "http://rt/api/v1/capabilities/cap-1/world-model/slice"
    assert captured["params"]["role"] == "developer"
    assert captured["params"]["task"] == "add a migration"


def test_slice_omits_empty_query_params(monkeypatch):
    captured = {}

    def handler(url, params):
        captured["params"] = params
        return _json_response({"data": {"worldModel": None, "views": []}})

    _fetch(monkeypatch, handler)
    assert captured["params"] == {}, "absent role/task must not be sent as empty strings"


def test_slice_accepts_unwrapped_body(monkeypatch):
    """Older/newer shapes: tolerate a body that is the slice itself."""
    wm, views, warning = _fetch(
        monkeypatch,
        lambda u, p: _json_response(
            {"worldModel": {"capabilityId": "cap-1"}, "views": [{"kind": "testing", "contentMd": "t"}]}
        ),
    )
    assert warning is None and wm and len(views) == 1


# ── degradation ──────────────────────────────────────────────────────────────
def test_no_views_built_is_not_a_failure(monkeypatch):
    """The normal state before an operator builds views. Must NOT warn, or every
    run would log a fallback and pay for a second fetch."""
    wm, views, warning = _fetch(
        monkeypatch,
        lambda u, p: _json_response({"data": {"worldModel": {"capabilityId": "cap-1"}, "views": []}}),
    )
    assert warning is None
    assert wm and views == []


def test_parent_capability_has_views_without_a_world_model(monkeypatch):
    """A capability with no repository. Views alone are a valid slice, and this
    must not warn — warning would trigger a pointless fallback that 404s."""
    wm, views, warning = _fetch(
        monkeypatch,
        lambda u, p: _json_response(
            {"data": {"worldModel": None, "views": [{"kind": "business", "contentMd": "b"}]}}
        ),
    )
    assert warning is None
    assert wm is None
    assert len(views) == 1


def test_404_is_not_a_fallback(monkeypatch):
    """Neither model nor views. The legacy endpoint would 404 too, so retrying
    it would only add latency."""
    wm, views, warning = _fetch(monkeypatch, lambda u, p: _json_response({}, status=404))
    assert (wm, views, warning) == (None, [], None)


@pytest.mark.parametrize("status", [500, 502, 503])
def test_server_errors_request_a_fallback(monkeypatch, status):
    wm, views, warning = _fetch(monkeypatch, lambda u, p: _json_response({}, status=status))
    assert wm is None and views == []
    assert warning and "fallback" in warning


def test_transport_error_requests_a_fallback(monkeypatch):
    def handler(url, params):
        raise httpx.ConnectError("refused", request=httpx.Request("GET", url))

    wm, views, warning = _fetch(monkeypatch, handler)
    assert warning and "fallback" in warning


def test_malformed_body_requests_a_fallback(monkeypatch):
    wm, views, warning = _fetch(monkeypatch, lambda u, p: _json_response(["not", "an", "object"]))
    assert warning and "fallback" in warning


def test_views_without_content_are_dropped(monkeypatch):
    """A view with no prose is a PENDING/FAILED row leaking through; rendering it
    would put an empty heading in the prompt."""
    _, views, _ = _fetch(
        monkeypatch,
        lambda u, p: _json_response(
            {
                "data": {
                    "worldModel": {"capabilityId": "cap-1"},
                    "views": [
                        {"kind": "core_summary", "contentMd": "ok"},
                        {"kind": "testing", "contentMd": ""},
                        {"kind": "release"},
                        "garbage",
                    ],
                }
            }
        ),
    )
    assert [v["kind"] for v in views] == ["core_summary"]


def test_missing_url_or_capability_is_silent(monkeypatch):
    assert asyncio.run(prompt_context.fetch_capability_world_model_slice("", "cap-1", 3.0)) == (None, [], None)
    assert asyncio.run(prompt_context.fetch_capability_world_model_slice("http://rt", "", 3.0)) == (None, [], None)


# ── the role ladder ──────────────────────────────────────────────────────────
def _req(*, agent_role=None, vars_=None, context_policy=None, tool_policy=None):
    v = dict(vars_ or {})
    if context_policy:
        v["stageContextPolicy"] = context_policy
    if tool_policy:
        v["stageToolPolicy"] = tool_policy
    return SimpleNamespace(run_context=SimpleNamespace(agent_role=agent_role), vars=v)


def test_declared_role_wins():
    assert execute_mod._resolve_agent_role(_req(agent_role="architect")) == "architect"


def test_declared_role_beats_vars_and_stage():
    req = _req(agent_role="architect", vars_={"agentRole": "tester"}, context_policy="CODE_EDIT")
    assert execute_mod._resolve_agent_role(req) == "architect"


def test_vars_role_is_used_when_nothing_is_declared():
    assert execute_mod._resolve_agent_role(_req(vars_={"agentRole": "release_manager"})) == "release_manager"


def test_vars_role_keeps_its_case_and_shape():
    """Read straight from vars, NOT through stage_policy_value — that helper
    upper-cases and dash-replaces for enum fields, and a role is a name."""
    assert execute_mod._resolve_agent_role(_req(vars_={"agentRole": "product-owner"})) == "product-owner"


def test_blank_roles_fall_through():
    assert execute_mod._resolve_agent_role(_req(agent_role="   ", vars_={"agentRole": "  "})) is None


def test_stage_shape_implies_a_role():
    assert execute_mod._resolve_agent_role(_req(context_policy="CODE_EDIT")) == "developer"
    assert execute_mod._resolve_agent_role(_req(tool_policy="MUTATION")) == "developer"


def test_no_signal_yields_none():
    """None is a valid answer: agent-runtime applies its own fallback, which is
    more honest than guessing a role here."""
    assert execute_mod._resolve_agent_role(_req()) is None


def test_role_resolution_never_raises_on_odd_input():
    assert execute_mod._resolve_agent_role(SimpleNamespace()) is None
    assert execute_mod._resolve_agent_role(SimpleNamespace(run_context=None, vars=None)) is None


# ── the API prefix ───────────────────────────────────────────────────────────
# agent-runtime mounts every resource under /api/v1 (app.ts), but AGENT_RUNTIME_URL
# is a bare host:port in every deployment path we ship. Both fetches below used the
# bare value, so they requested /capabilities/... and 404'd — and because the slice
# fetch reports a 404 as "no world model yet" with NO warning, the result was
# indistinguishable from a capability that had never been distilled. Every consumer
# (composed /execute, the governed stage loop, the copilot executor) silently ran
# with no CODE_AGENT_RULES and no CODE_WORLD_MODEL.
def test_api_base_adds_the_prefix():
    assert prompt_context.agent_runtime_api_base("http://rt") == "http://rt/api/v1"
    assert prompt_context.agent_runtime_api_base("http://rt/") == "http://rt/api/v1"


def test_api_base_is_idempotent():
    """A deployment that later sets the variable WITH the suffix must not get
    /api/v1/api/v1."""
    assert prompt_context.agent_runtime_api_base("http://rt/api/v1") == "http://rt/api/v1"
    assert prompt_context.agent_runtime_api_base("http://rt/api/v1/") == "http://rt/api/v1"


def test_api_base_keeps_empty_empty():
    """Unset agent-runtime stays unset — the fetches short-circuit on it."""
    assert prompt_context.agent_runtime_api_base("") == ""
    assert prompt_context.agent_runtime_api_base(None) == ""


def test_slice_requests_the_mounted_path(monkeypatch):
    captured = {}

    def handler(url, params):
        captured["url"] = url
        return _json_response({"success": True, "data": {"worldModel": None, "views": []}})

    _fetch(monkeypatch, handler, role="developer")
    assert captured["url"] == "http://rt/api/v1/capabilities/cap-1/world-model/slice"


def test_capability_wide_fetch_requests_the_mounted_path(monkeypatch):
    """The legacy fallback had the same defect, so fixing only the slice would
    have left the fallback path still 404ing."""
    captured = {}

    def handler(url, params):
        captured["url"] = url
        return _json_response({"success": True, "data": {"capabilityId": "cap-1"}})

    monkeypatch.setattr(prompt_context.httpx, "AsyncClient", _client_returning(handler))
    wm, warning = asyncio.run(
        prompt_context.fetch_capability_world_model("http://rt", "cap-1", 2.0)
    )
    assert warning is None and wm["capabilityId"] == "cap-1"
    assert captured["url"] == "http://rt/api/v1/capabilities/cap-1/world-model"
