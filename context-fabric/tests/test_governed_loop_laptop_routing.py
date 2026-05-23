"""M75 Slice 4 — governed_step honors run_context.prefer_laptop.

The dispatch routing (HTTP vs WS bridge) lives in `governed.dispatch`
and is covered by `test_laptop_dispatch_routing.py`. THIS file covers
the layer above: `governed.loop.governed_step` reading the operator
toggle off `run_context` and translating it into the
`laptop_user_id` kwarg that dispatch_tool consumes.

Pinned contracts (per docs/M75-laptop-bridge-cutover.md Slice 4):

  • prefer_laptop=True + user_id present  → laptop_user_id = str(user_id)
  • prefer_laptop=False + user_id present → laptop_user_id = None
  • prefer_laptop missing                  → laptop_user_id = None
  • prefer_laptop=True + user_id missing  → laptop_user_id = None
  • prefer_laptop truthy-but-not-bool      → laptop_user_id = None
    (strict `is True`; rejects "true", 1, etc. so a misconfigured
    caller can't silently flip routing)
  • userId camelCase alias works            (workgraph-api uses snake_case
    but other callers in the tree have legacy camelCase)

Reason for strictness: the laptop bridge changes failure modes (timeout
characteristics, audit-event shape, security envelope) — a silent flip
from HTTP to bridge because someone passed the string "true" would be
a real-world incident.

Uses asyncio.run() rather than pytest.mark.asyncio to match the local
`test_laptop_dispatch_routing.py` pattern — keeps the suite runnable
without the pytest-asyncio plugin pinned.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from context_api_service.app.governed import (
    Phase,
    PhasePolicy,
    PhaseState,
    StagePolicy,
    ToolDispatchResult,
    governed_step,
)


def _run(coro):
    return asyncio.run(coro)


def _policy(allowed: list[str]) -> StagePolicy:
    """Minimal StagePolicy with `allowed` whitelisted in PLAN."""
    return StagePolicy(
        policy_id="laptop-routing-policy",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        version=1,
        status="ACTIVE",
        approval_model={},
        limits={"max_repair_attempts": 3},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={},
        phases={
            Phase.PLAN: PhasePolicy(
                phase=Phase.PLAN,
                allowed_tools=frozenset(allowed),
                forbidden_tools=frozenset(),
                required_output_schema={},
                max_input_tokens=None,
                max_output_tokens=None,
                max_tool_calls=None,
            ),
        },
    )


def _install_dispatch_capture(monkeypatch) -> dict[str, Any]:
    """Patch dispatch_tool to record kwargs (esp. laptop_user_id) and
    return a canned success. Returns the captured-kwargs dict."""
    captured: dict[str, Any] = {}

    async def fake_dispatch(*, tool_name, args, **kwargs):
        captured["tool_name"] = tool_name
        captured["args"] = args
        captured.update(kwargs)
        return ToolDispatchResult(
            result={"ok": True},
            duration_ms=1,
            tool_invocation_id="ti-routing",
            tool_success=True,
            tool_error=None,
        )

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )
    return captured


@pytest.fixture(autouse=True)
def _silence_audit(monkeypatch):
    async def _noop(**_kwargs):
        return None

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.emit_governed_event", _noop
    )


def _step(*, policy: StagePolicy, run_context: dict[str, Any] | None):
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    return _run(governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[{"name": "repo_map", "args": {"max_directories": 10}}],
        run_context=run_context,
        policy=policy,
    ))


# ── True + user_id → route via bridge ──────────────────────────────────────


def test_prefer_laptop_true_with_user_id_routes_to_laptop(monkeypatch):
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={"prefer_laptop": True, "user_id": "user-42"},
    )
    assert captured["laptop_user_id"] == "user-42"


def test_user_id_is_coerced_to_string(monkeypatch):
    """user_id might arrive as an int (IAM sub from a DB column). The
    laptop_registry's `dispatch_tool_via_laptop` wants a string —
    governed_step coerces."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={"prefer_laptop": True, "user_id": 12345},
    )
    assert captured["laptop_user_id"] == "12345"


def test_user_id_camel_case_alias_works(monkeypatch):
    """Snake_case is the workgraph-api convention but some legacy
    callers in the tree still emit camelCase. governed_step accepts
    either so a refactor of the upstream contract doesn't silently
    disable bridge routing."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={"prefer_laptop": True, "userId": "user-camel"},
    )
    assert captured["laptop_user_id"] == "user-camel"


# ── False / missing / wrong type → stay on HTTP ────────────────────────────


def test_prefer_laptop_false_forces_http(monkeypatch):
    """Workgraph QA stages explicitly set False — must NEVER route to
    laptop, even if a user_id is present."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={"prefer_laptop": False, "user_id": "user-99"},
    )
    assert captured["laptop_user_id"] is None


def test_prefer_laptop_missing_stays_on_http(monkeypatch):
    """No prefer_laptop key → HTTP. Auto-prefer-when-available is a
    future enhancement that needs upstream `is bridge live?` plumbing."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={"user_id": "user-77"},
    )
    assert captured["laptop_user_id"] is None


def test_prefer_laptop_true_without_user_id_stays_on_http(monkeypatch):
    """The bridge is keyed on user_id — without one, there's no laptop
    to route to. Defensive: don't synthesize a fake key, just fall
    through to HTTP."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={"prefer_laptop": True},
    )
    assert captured["laptop_user_id"] is None


@pytest.mark.parametrize("truthy_but_not_bool", ["true", "True", 1, "yes"])
def test_prefer_laptop_string_truthy_does_NOT_route(monkeypatch, truthy_but_not_bool):
    """Strict `is True` — a string "true" must NOT silently enable
    bridge routing. The check protects against config / serialisation
    bugs upstream where a YAML value or query string got passed
    through without being coerced."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context={
            "prefer_laptop": truthy_but_not_bool,
            "user_id": "user-strict",
        },
    )
    assert captured["laptop_user_id"] is None


def test_no_run_context_at_all_stays_on_http(monkeypatch):
    """run_context=None must not crash. The legacy /execute path
    sometimes doesn't pass run_context at all (operator-side ad-hoc
    invocations) — must default to HTTP, not raise AttributeError."""
    captured = _install_dispatch_capture(monkeypatch)
    _step(
        policy=_policy(["repo_map"]),
        run_context=None,
    )
    assert captured["laptop_user_id"] is None
