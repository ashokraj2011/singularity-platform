from __future__ import annotations

import asyncio

import pytest

from context_api_service.app import laptop_registry as lr
from context_api_service.app.laptop_registry import (
    ActiveConnection,
    LaptopRegistry,
    _safe_health_metadata,
    _sanitize_metadata,
)


def _run(coro):
    return asyncio.run(coro)


def test_sanitize_metadata_redacts_nested_secret_shaped_fields():
    raw = {
        "llm_gateway_url_configured": True,
        "llm_gateway_url": "http://localhost:8001/",
        "githubToken": "github_pat_secret",
        "nested": {
            "Authorization": "Bearer abc",
            "plain": "ok",
            "items": [
                {"api_key": "sk-secret"},
                {"value": "still visible"},
            ],
        },
    }

    sanitized = _sanitize_metadata(raw)

    assert sanitized["llm_gateway_url_configured"] is True
    assert sanitized["llm_gateway_url"] == "http://localhost:8001/"
    assert sanitized["githubToken"] == "[redacted]"
    assert sanitized["nested"]["Authorization"] == "[redacted]"
    assert sanitized["nested"]["plain"] == "ok"
    assert sanitized["nested"]["items"][0]["api_key"] == "[redacted]"
    assert sanitized["nested"]["items"][1]["value"] == "still visible"


def test_sanitize_metadata_bounds_lists_dicts_and_long_strings():
    raw = {f"k{i}": i for i in range(55)}
    raw["long"] = "x" * 600
    raw["list"] = list(range(25))

    sanitized = _sanitize_metadata(raw)

    assert sanitized["__truncated__"] is True
    assert len(sanitized) == 51
    nested = _sanitize_metadata({"long": "x" * 600, "list": list(range(25))})
    assert nested["long"].endswith("...[truncated]")
    assert len(nested["list"]) == 21
    assert nested["list"][-1] == "[truncated]"


def test_safe_health_metadata_returns_sanitized_dict_only():
    assert _safe_health_metadata("not-a-dict") == {}
    assert _safe_health_metadata({
        "authorization": "Bearer secret",
        "items": list(range(25)),
    }) == {
        "authorization": "[redacted]",
        "items": [*range(20), "[truncated]"],
    }


def test_status_and_diagnostics_sanitize_runtime_health_metadata():
    registry = LaptopRegistry()
    now = 1.0
    _run(registry.register(ActiveConnection(
        user_id="user-a",
        device_id="runtime-a",
        device_name="runtime",
        ws=object(),  # type: ignore[arg-type]
        connected_at=now,
        last_seen_at=now,
        supported_frame_types=["source-file"],
        runtime_id="runtime-a",
        runtime_type="mcp",
        capability_tags=["mcp"],
        health={
            "llm_gateway_url_configured": True,
            "token": "runtime-secret",
            "nested": {"password": "p"},
        },
    )))

    status = _run(registry.status_snapshot())
    diagnostics = _run(registry.diagnostics(user_id="user-a", frame_type="source-file", capability_tags=["mcp"]))
    stored = registry._by_user["user-a"]["runtime-a"].health

    assert status["connected"][0]["health"] == {
        "llm_gateway_url_configured": True,
        "token": "[redacted]",
        "nested": {"password": "[redacted]"},
    }
    assert stored == status["connected"][0]["health"]
    assert diagnostics["selected"]["health"]["token"] == "[redacted]"
    assert diagnostics["selected"]["health"]["nested"]["password"] == "[redacted]"


def test_heartbeat_updates_runtime_health_metadata_safely():
    registry = LaptopRegistry()
    now = 1.0
    _run(registry.register(ActiveConnection(
        user_id="user-a",
        device_id="runtime-a",
        device_name="runtime",
        ws=object(),  # type: ignore[arg-type]
        connected_at=now,
        last_seen_at=now,
        supported_frame_types=["model-run"],
        runtime_id="runtime-a",
        runtime_type="mcp",
        capability_tags=["llm"],
        health={"llm_gateway_url_configured": False},
    )))

    _run(registry.heartbeat("user-a", "runtime-a", {
        "llm_gateway_url_configured": True,
        "llm_providers": [{"name": "copilot", "ready": True}],
        "api_key": "must-not-leak",
        "long": "x" * 600,
    }))
    status = _run(registry.status_snapshot())
    stored = registry._by_user["user-a"]["runtime-a"].health

    assert status["connected"][0]["health"]["llm_gateway_url_configured"] is True
    assert status["connected"][0]["health"]["llm_providers"] == [{"name": "copilot", "ready": True}]
    assert status["connected"][0]["health"]["api_key"] == "[redacted]"
    assert stored["api_key"] == "[redacted]"
    assert stored["long"].endswith("...[truncated]")


def test_bounded_int_env_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME", raising=False)
    assert lr._bounded_int_env(
        "RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME",
        default=32,
        min_value=1,
        max_value=1024,
    ) == 32

    monkeypatch.setenv("RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME", "not-an-int")
    assert lr._bounded_int_env(
        "RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME",
        default=32,
        min_value=1,
        max_value=1024,
    ) == 32

    monkeypatch.setenv("RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME", "0")
    assert lr._bounded_int_env(
        "RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME",
        default=32,
        min_value=1,
        max_value=1024,
    ) == 32

    monkeypatch.setenv("RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME", "64")
    assert lr._bounded_int_env(
        "RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME",
        default=32,
        min_value=1,
        max_value=1024,
    ) == 64

    monkeypatch.setenv("RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME", "5000")
    assert lr._bounded_int_env(
        "RUNTIME_BRIDGE_MAX_PENDING_PER_RUNTIME",
        default=32,
        min_value=1,
        max_value=1024,
    ) == 1024


def test_deliver_response_rejects_oversized_runtime_payload(monkeypatch):
    monkeypatch.setattr(lr, "MAX_PAYLOAD_BYTES", 64)

    async def _case():
        registry = LaptopRegistry()
        conn = ActiveConnection(
            user_id="user-a",
            device_id="runtime-a",
            device_name="runtime",
            ws=object(),  # type: ignore[arg-type]
            connected_at=1.0,
            last_seen_at=1.0,
            supported_frame_types=["model-run"],
        )
        await registry.register(conn)
        fut = asyncio.get_running_loop().create_future()
        conn.pending["req-1"] = fut

        await registry.deliver_response("user-a", "runtime-a", "req-1", {"blob": "x" * 80}, None)

        with pytest.raises(lr.LaptopInvokeError) as exc:
            await fut
        assert exc.value.code == "RUNTIME_RESPONSE_TOO_LARGE"
        assert exc.value.details["field"] == "payload"
        assert exc.value.details["max_bytes"] == 64

    _run(_case())


def test_deliver_response_rejects_oversized_runtime_error(monkeypatch):
    monkeypatch.setattr(lr, "MAX_PAYLOAD_BYTES", 64)

    async def _case():
        registry = LaptopRegistry()
        conn = ActiveConnection(
            user_id="user-a",
            device_id="runtime-a",
            device_name="runtime",
            ws=object(),  # type: ignore[arg-type]
            connected_at=1.0,
            last_seen_at=1.0,
            supported_frame_types=["tool-run"],
        )
        await registry.register(conn)
        fut = asyncio.get_running_loop().create_future()
        conn.pending["req-2"] = fut

        await registry.deliver_response(
            "user-a",
            "runtime-a",
            "req-2",
            None,
            {"code": "TOOL_FAILED", "message": "x" * 80},
        )

        with pytest.raises(lr.LaptopInvokeError) as exc:
            await fut
        assert exc.value.code == "RUNTIME_RESPONSE_TOO_LARGE"
        assert exc.value.details["field"] == "error"

    _run(_case())


def test_deliver_response_normalizes_malformed_runtime_error():
    async def _case():
        registry = LaptopRegistry()
        conn = ActiveConnection(
            user_id="user-a",
            device_id="runtime-a",
            device_name="runtime",
            ws=object(),  # type: ignore[arg-type]
            connected_at=1.0,
            last_seen_at=1.0,
            supported_frame_types=["tool-run"],
        )
        await registry.register(conn)
        fut = asyncio.get_running_loop().create_future()
        conn.pending["req-3"] = fut

        await registry.deliver_response("user-a", "runtime-a", "req-3", None, "not-an-object")

        with pytest.raises(lr.LaptopInvokeError) as exc:
            await fut
        assert exc.value.code == "INVALID_RUNTIME_ERROR"
        assert exc.value.details == {"error_type": "str"}

    _run(_case())


def test_outbound_runtime_frame_size_is_checked_before_send(monkeypatch):
    monkeypatch.setattr(lr, "MAX_PAYLOAD_BYTES", 180)

    class RejectingWS:
        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send_text(self, text: str) -> None:
            self.sent.append(text)
            raise AssertionError("oversized frame should not be sent")

    async def _case():
        registry = LaptopRegistry()
        ws = RejectingWS()
        conn = ActiveConnection(
            user_id="user-a",
            device_id="runtime-a",
            device_name="runtime",
            ws=ws,  # type: ignore[arg-type]
            connected_at=1.0,
            last_seen_at=1.0,
            supported_frame_types=["model-run"],
        )
        await registry.register(conn)

        with pytest.raises(lr.LaptopSendFailed, match="RUNTIME_FRAME_TOO_LARGE"):
            await registry.dispatch_model_via_laptop(
                user_id="user-a",
                request_body={"messages": [{"role": "user", "content": "x" * 500}]},
            )

        assert ws.sent == []
        assert conn.pending == {}

    _run(_case())


def test_runtime_pending_request_cap_rejects_before_send(monkeypatch):
    monkeypatch.setattr(lr, "MAX_PENDING_REQUESTS_PER_RUNTIME", 1)

    class RejectingWS:
        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send_text(self, text: str) -> None:
            self.sent.append(text)
            raise AssertionError("runtime at pending cap should not receive another frame")

    async def _case():
        registry = LaptopRegistry()
        ws = RejectingWS()
        conn = ActiveConnection(
            user_id="user-a",
            device_id="runtime-a",
            device_name="runtime",
            ws=ws,  # type: ignore[arg-type]
            connected_at=1.0,
            last_seen_at=1.0,
            supported_frame_types=["model-run"],
        )
        conn.pending["existing"] = asyncio.get_running_loop().create_future()
        await registry.register(conn)

        with pytest.raises(lr.LaptopSendFailed, match="RUNTIME_BUSY"):
            await registry.dispatch_model_via_laptop(
                user_id="user-a",
                request_body={"messages": [{"role": "user", "content": "hi"}]},
            )

        assert ws.sent == []
        assert list(conn.pending.keys()) == ["existing"]

    _run(_case())
