from __future__ import annotations

import asyncio

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
