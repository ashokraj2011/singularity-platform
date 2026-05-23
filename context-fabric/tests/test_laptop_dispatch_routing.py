"""M75 Slice 3 — platform-side tool-run dispatch routing tests.

Covers `governed.dispatch.dispatch_tool` with the new `laptop_user_id`
keyword argument. Three contracts pinned:

  1. Without laptop_user_id, the HTTP path is unchanged (regression
     guard for existing callers).
  2. With laptop_user_id + a live laptop, the bridge path runs and
     returns the same ToolDispatchResult shape as HTTP.
  3. With laptop_user_id but NO live laptop, the dispatcher transparently
     falls back to HTTP (LaptopNotConnected → _LaptopUnavailable →
     HTTP path). The orchestrator-level "require laptop" check is a
     separate concern.

The laptop_registry's send / timeout / runner-failure paths each map
to distinct ToolDispatchError messages — pinned via parameterised
assertions so a refactor of the exception hierarchy surfaces in tests
instead of silently as a different error string downstream.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import pytest

from context_api_service.app.governed.dispatch import (
    ToolDispatchError,
    ToolDispatchResult,
    dispatch_tool,
)


def _run(coro):
    return asyncio.run(coro)


# ── Fake laptop registry — mounted via monkeypatch of the lazy import ──

class _FakeLaptopErrors:
    class LaptopNotConnected(Exception): ...
    class LaptopSendFailed(Exception): ...
    class LaptopInvokeTimeout(Exception): ...
    class LaptopInvokeError(Exception):
        def __init__(self, *, code: str, message: str, details: Any = None) -> None:
            super().__init__(message)
            self.code = code
            self.message = message
            self.details = details


def _patch_registry(behavior):
    """Patch the lazy import target in dispatch._dispatch_via_laptop so
    the registry's dispatch_tool_via_laptop is `behavior`. The other
    exception classes (NotConnected / SendFailed / Timeout /
    InvokeError) ride from _FakeLaptopErrors so each test can throw
    them without import-cycles."""
    from context_api_service.app import laptop_registry as real_registry

    class FakeRegistry:
        async def dispatch_tool_via_laptop(self, **kwargs):
            return await behavior(kwargs)

    return patch.multiple(
        real_registry,
        REGISTRY=FakeRegistry(),
        LaptopNotConnected=_FakeLaptopErrors.LaptopNotConnected,
        LaptopSendFailed=_FakeLaptopErrors.LaptopSendFailed,
        LaptopInvokeTimeout=_FakeLaptopErrors.LaptopInvokeTimeout,
        LaptopInvokeError=_FakeLaptopErrors.LaptopInvokeError,
    )


# ── HTTP path unchanged when no laptop_user_id ─────────────────────────────


def test_dispatch_without_laptop_user_id_uses_http():
    """No laptop_user_id → never touches the registry. The HTTP path
    runs (and may fail since we don't mock httpx — that's fine, we're
    asserting the routing decision, not the HTTP call)."""
    # Patch the registry call to raise if it's ever invoked; if the
    # routing is wrong we'll see that error instead of the expected
    # HTTP-path error.
    async def must_not_call(_kwargs):
        raise AssertionError("registry should not be touched when laptop_user_id is None")

    with _patch_registry(must_not_call):
        with patch(
            "context_api_service.app.governed.dispatch.httpx.AsyncClient"
        ) as mock_client_factory:
            mock_client = mock_client_factory.return_value.__aenter__.return_value
            mock_response = type("Resp", (), {
                "is_success": True,
                "status_code": 200,
                "text": "",
                "json": lambda self: {
                    "success": True,
                    "data": {
                        "result": {"ok": True},
                        "durationMs": 5,
                        "toolInvocationId": "ti-http",
                        "toolSuccess": True,
                    },
                },
            })()

            async def fake_post(*args, **kwargs):
                return mock_response

            mock_client.post = fake_post

            outcome = _run(dispatch_tool(
                "read_file",
                {"path": "a.py"},
                work_item_id="WI-1",
                run_context={"traceId": "t1"},
                bearer="tok-test",
            ))
    assert outcome.tool_invocation_id == "ti-http"
    assert outcome.tool_success is True
    # M75 Slice 5 — HTTP path always stamps served_by="http", leaves
    # device fields None. The audit emit short-circuits on that.
    assert outcome.served_by == "http"
    assert outcome.laptop_device_id is None
    assert outcome.laptop_device_name is None


# ── Bridge path runs when laptop_user_id + live bridge ─────────────────────


def test_dispatch_with_laptop_user_id_routes_via_bridge():
    """When a live bridge returns a tool-run response, the dispatcher
    normalises snake_case wire fields into the same ToolDispatchResult
    shape the HTTP path produces.

    M75 Slice 5: dispatch_tool_via_laptop returns (payload, device_meta)
    so the dispatcher can stamp served_by="laptop" + laptop_device_id /
    laptop_device_name on the result for the audit emit downstream."""
    seen_call: dict[str, Any] = {}

    async def bridge_returns_ok(kwargs):
        seen_call.update(kwargs)
        return (
            {
                "result": {"branches": ["main"]},
                "duration_ms": 42,
                "tool_invocation_id": "ti-laptop",
                "tool_success": True,
                "tool_error": None,
            },
            {"device_id": "dev-abc", "device_name": "ashok-mbp"},
        )

    with _patch_registry(bridge_returns_ok):
        outcome = _run(dispatch_tool(
            "repo_map",
            {"max_directories": 50},
            work_item_id="WI-2",
            run_context={"traceId": "t2", "attemptId": "a2"},
            laptop_user_id="user-42",
        ))

    assert isinstance(outcome, ToolDispatchResult)
    assert outcome.tool_invocation_id == "ti-laptop"
    assert outcome.duration_ms == 42
    assert outcome.tool_success is True
    assert outcome.result == {"branches": ["main"]}
    # M75 Slice 5 — provenance threaded through to the result.
    assert outcome.served_by == "laptop"
    assert outcome.laptop_device_id == "dev-abc"
    assert outcome.laptop_device_name == "ashok-mbp"
    # The registry call carried the tool name + args + work_item_id
    # + run_context through unchanged.
    assert seen_call["user_id"] == "user-42"
    assert seen_call["tool_name"] == "repo_map"
    assert seen_call["args"] == {"max_directories": 50}
    assert seen_call["work_item_id"] == "WI-2"
    assert seen_call["run_context"] == {"traceId": "t2", "attemptId": "a2"}


def test_dispatch_bridge_tool_soft_failure_passes_through():
    """A tool that ran on the laptop but reported success=false
    surfaces as tool_success=False on the result, NOT as a throw —
    matching the HTTP path contract."""
    async def bridge_returns_softfail(_kwargs):
        return (
            {
                "result": None,
                "duration_ms": 10,
                "tool_invocation_id": "ti-soft",
                "tool_success": False,
                "tool_error": "patch did not apply cleanly",
            },
            {"device_id": "dev-soft", "device_name": "test-laptop"},
        )

    with _patch_registry(bridge_returns_softfail):
        outcome = _run(dispatch_tool(
            "apply_patch",
            {"patch": "..."},
            laptop_user_id="user-7",
        ))

    assert outcome.tool_success is False
    assert outcome.tool_error == "patch did not apply cleanly"
    # M75 Slice 5 — even a soft tool failure carries laptop provenance
    # so operators searching audit-gov for "all laptop activity" see
    # the failed call too, not just the successful ones.
    assert outcome.served_by == "laptop"
    assert outcome.laptop_device_id == "dev-soft"


# ── Fallback path: no bridge connected → HTTP ──────────────────────────────


def test_dispatch_falls_back_to_http_when_laptop_not_connected():
    """LaptopNotConnected → _LaptopUnavailable internally → HTTP path
    runs. Tested by raising the not-connected error from the registry
    and asserting the HTTP mock was hit."""
    http_called: dict[str, Any] = {"hit": False}

    async def bridge_not_connected(_kwargs):
        raise _FakeLaptopErrors.LaptopNotConnected("no live laptop for user")

    with _patch_registry(bridge_not_connected):
        with patch(
            "context_api_service.app.governed.dispatch.httpx.AsyncClient"
        ) as mock_client_factory:
            mock_client = mock_client_factory.return_value.__aenter__.return_value

            async def fake_post(*args, **kwargs):
                http_called["hit"] = True
                return type("Resp", (), {
                    "is_success": True,
                    "status_code": 200,
                    "text": "",
                    "json": lambda self: {
                        "success": True,
                        "data": {
                            "result": "from-http",
                            "durationMs": 1,
                            "toolInvocationId": "ti-fallback",
                            "toolSuccess": True,
                        },
                    },
                })()

            mock_client.post = fake_post

            outcome = _run(dispatch_tool(
                "read_file",
                {"path": "x.py"},
                laptop_user_id="user-no-bridge",
                bearer="tok",
            ))
    assert http_called["hit"], "HTTP path should have run after laptop fallback"
    assert outcome.tool_invocation_id == "ti-fallback"


# ── Bridge error mapping ───────────────────────────────────────────────────


@pytest.mark.parametrize("err_factory,expected_substr", [
    (lambda: _FakeLaptopErrors.LaptopSendFailed("ws send failed"), "LAPTOP_SEND_FAILED"),
    (lambda: _FakeLaptopErrors.LaptopInvokeTimeout("timed out after 120s"), "LAPTOP_TIMEOUT"),
    (lambda: _FakeLaptopErrors.LaptopInvokeError(
        code="TOOL_RUN_FAILED", message="kaboom"
    ), "TOOL_RUN_FAILED"),
])
def test_dispatch_bridge_errors_map_to_tool_dispatch_error(err_factory, expected_substr):
    """Each bridge-level failure mode maps to a distinct
    ToolDispatchError code so the orchestrator can render specific
    operator copy (and a future eval rubric can pattern-match)."""
    async def bridge_throws(_kwargs):
        raise err_factory()

    with _patch_registry(bridge_throws):
        with pytest.raises(ToolDispatchError) as exc_info:
            _run(dispatch_tool(
                "read_file",
                {"path": "a"},
                laptop_user_id="user-broken",
            ))
    assert expected_substr in str(exc_info.value)


def test_dispatch_bridge_non_dict_response_raises():
    """Defensive: if the laptop ever returns a non-dict (protocol drift,
    serialisation bug), surface it as a ToolDispatchError rather than
    crashing with an attribute error downstream."""
    async def bridge_returns_string(_kwargs):
        return "not a dict"  # type: ignore[return-value]

    with _patch_registry(bridge_returns_string):
        with pytest.raises(ToolDispatchError, match="not a dict"):
            _run(dispatch_tool(
                "read_file",
                {"path": "a"},
                laptop_user_id="user-x",
            ))


# ── M75 Slice 6 — emergency rollback flag ──────────────────────────────────


def test_LAPTOP_USE_LEGACY_INVOKE_forces_http_even_with_user_id(monkeypatch):
    """The emergency rollback env flag must short-circuit the laptop
    path BEFORE the registry lookup. Asserted by: registry mock that
    fails the test if touched, plus HTTP mock that asserts it was hit
    with the right tool name. If the flag silently failed to engage,
    we'd see the registry assertion fire instead.

    Truthy values "1", "true", "yes", "on" all engage the flag. False
    values (anything else, including "false", "0", empty string) leave
    the laptop path active — same parsing model as the rest of CF's
    boolean env vars (cf. config.py)."""
    async def must_not_call(_kwargs):
        raise AssertionError(
            "registry should not be touched when LAPTOP_USE_LEGACY_INVOKE is active"
        )

    monkeypatch.setenv("LAPTOP_USE_LEGACY_INVOKE", "true")

    with _patch_registry(must_not_call):
        with patch(
            "context_api_service.app.governed.dispatch.httpx.AsyncClient"
        ) as mock_client_factory:
            mock_client = mock_client_factory.return_value.__aenter__.return_value
            seen_url: dict[str, str] = {}

            async def fake_post(url, *args, **kwargs):
                seen_url["url"] = url
                return type("Resp", (), {
                    "is_success": True,
                    "status_code": 200,
                    "text": "",
                    "json": lambda self: {
                        "success": True,
                        "data": {
                            "result": {"rollback": True},
                            "durationMs": 7,
                            "toolInvocationId": "ti-rollback",
                            "toolSuccess": True,
                        },
                    },
                })()

            mock_client.post = fake_post

            outcome = _run(dispatch_tool(
                "read_file",
                {"path": "x.py"},
                laptop_user_id="user-with-bridge",
                bearer="tok",
            ))

    assert outcome.served_by == "http"
    assert outcome.tool_invocation_id == "ti-rollback"
    assert "/mcp/tool-run" in seen_url["url"]


@pytest.mark.parametrize("inactive_value", ["false", "0", "", "no", "off", "FaLsE"])
def test_LAPTOP_USE_LEGACY_INVOKE_inactive_values_keep_laptop_path(
    monkeypatch, inactive_value,
):
    """Negative cases for the rollback flag: anything that isn't one of
    {"1","true","yes","on"} (case-insensitive) leaves bridge routing
    enabled. "FaLsE" is the tricky one — strict casing on "true" would
    accidentally engage the flag for anything non-empty."""
    async def bridge_returns_ok(_kwargs):
        return (
            {
                "result": {"branches": ["main"]},
                "duration_ms": 1,
                "tool_invocation_id": "ti-laptop-still",
                "tool_success": True,
                "tool_error": None,
            },
            {"device_id": "dev-x", "device_name": "n"},
        )

    monkeypatch.setenv("LAPTOP_USE_LEGACY_INVOKE", inactive_value)

    with _patch_registry(bridge_returns_ok):
        outcome = _run(dispatch_tool(
            "repo_map",
            {},
            laptop_user_id="user-x",
        ))
    assert outcome.served_by == "laptop"
    assert outcome.tool_invocation_id == "ti-laptop-still"


def test_dispatch_bridge_bare_dict_response_still_routes():
    """Back-compat: pre-Slice-5 mocks (and any rogue registry
    implementation) that return a bare dict instead of (payload, meta)
    must still produce a valid ToolDispatchResult. served_by stays
    'laptop' so the routing decision is preserved, but the device
    fields are None — the audit emit safely skips the
    tool_dispatched_via_laptop event when device_id is missing."""
    async def bridge_returns_bare_dict(_kwargs):
        return {
            "result": {"ok": True},
            "duration_ms": 5,
            "tool_invocation_id": "ti-bare",
            "tool_success": True,
            "tool_error": None,
        }

    with _patch_registry(bridge_returns_bare_dict):
        outcome = _run(dispatch_tool(
            "read_file",
            {"path": "a.py"},
            laptop_user_id="user-bare",
        ))

    assert outcome.tool_invocation_id == "ti-bare"
    assert outcome.served_by == "laptop"
    assert outcome.laptop_device_id is None
    assert outcome.laptop_device_name is None
