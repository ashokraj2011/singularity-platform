from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.testclient import TestClient

from context_api_service.app import laptop_bridge


def _configure(
    monkeypatch: pytest.MonkeyPatch,
    *,
    production: bool = False,
    iam_token: str = "cf-service-token",
    env_token: str | None = None,
    allow_unauthenticated: bool = False,
) -> None:
    monkeypatch.setattr(laptop_bridge, "is_production_class_env", lambda: production)
    monkeypatch.setattr(laptop_bridge.settings, "iam_service_token", iam_token)
    if env_token is None:
        monkeypatch.delenv("CONTEXT_FABRIC_SERVICE_TOKEN", raising=False)
    else:
        monkeypatch.setenv("CONTEXT_FABRIC_SERVICE_TOKEN", env_token)
    if allow_unauthenticated:
        monkeypatch.setenv("RUNTIME_BRIDGE_ALLOW_UNAUTHENTICATED_HTTP", "true")
    else:
        monkeypatch.delenv("RUNTIME_BRIDGE_ALLOW_UNAUTHENTICATED_HTTP", raising=False)
    monkeypatch.delenv("RUNTIME_HTTP_FALLBACK_ENABLED", raising=False)


def test_runtime_bridge_http_requires_token_even_when_execute_is_relaxed(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token")

    with pytest.raises(HTTPException) as exc:
        laptop_bridge.check_runtime_bridge_service_token(None)

    assert exc.value.status_code == 401
    assert exc.value.detail == "missing runtime bridge service token"


def test_runtime_bridge_http_accepts_configured_iam_service_token(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token")

    laptop_bridge.check_runtime_bridge_service_token("cf-service-token")


def test_runtime_bridge_http_accepts_context_fabric_service_token(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="", env_token="cf-env-token")

    laptop_bridge.check_runtime_bridge_service_token("cf-env-token")


def test_runtime_bridge_http_rejects_invalid_token(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token", env_token="cf-env-token")

    with pytest.raises(HTTPException) as exc:
        laptop_bridge.check_runtime_bridge_service_token("wrong")

    assert exc.value.status_code == 401
    assert exc.value.detail == "invalid runtime bridge service token"


def test_runtime_bridge_http_dev_escape_hatch_is_explicit(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="", allow_unauthenticated=True)

    laptop_bridge.check_runtime_bridge_service_token(None)


def test_runtime_bridge_http_dev_escape_hatch_is_ignored_in_production(monkeypatch):
    _configure(monkeypatch, production=True, iam_token="cf-service-token", allow_unauthenticated=True)

    with pytest.raises(HTTPException) as exc:
        laptop_bridge.check_runtime_bridge_service_token(None)

    assert exc.value.status_code == 401


def test_runtime_bridge_status_endpoint_requires_service_token(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token")

    async def fake_status_snapshot():
        return {"status": "ok", "connected": [], "count": 0, "tenants": {}}

    monkeypatch.setattr(laptop_bridge.REGISTRY, "status_snapshot", fake_status_snapshot)
    app = FastAPI()
    app.include_router(laptop_bridge.router)
    client = TestClient(app, raise_server_exceptions=False)

    missing = client.get("/api/runtime-bridge/status")
    accepted = client.get("/api/runtime-bridge/status", headers={"X-Service-Token": "cf-service-token"})

    assert missing.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "ok"


def test_laptop_bridge_status_alias_requires_service_token(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token")

    async def fake_status_snapshot():
        return {"status": "ok", "connected": [], "count": 0, "tenants": {}}

    monkeypatch.setattr(laptop_bridge.REGISTRY, "status_snapshot", fake_status_snapshot)
    app = FastAPI()
    app.include_router(laptop_bridge.router)
    client = TestClient(app, raise_server_exceptions=False)

    missing = client.get("/api/laptop-bridge/status")
    accepted = client.get("/api/laptop-bridge/status", headers={"X-Service-Token": "cf-service-token"})

    assert missing.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "ok"


def test_work_finish_branch_http_fallback_is_explicit(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token")

    async def unexpected_http_fallback(_payload):
        raise AssertionError("direct MCP HTTP fallback should not run")

    monkeypatch.setattr(laptop_bridge, "_http_finish_branch", unexpected_http_fallback)
    app = FastAPI()
    app.include_router(laptop_bridge.router)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/api/runtime-bridge/work/finish-branch",
        headers={"X-Service-Token": "cf-service-token"},
        json={"message": "test", "runContext": {}},
    )

    assert response.status_code == 503
    assert "RUNTIME_NOT_CONNECTED" in response.json()["detail"]
    assert "RUNTIME_HTTP_FALLBACK_ENABLED=true" in response.json()["detail"]


def test_worktree_file_http_fallback_is_explicit(monkeypatch):
    _configure(monkeypatch, production=False, iam_token="cf-service-token")

    async def unexpected_http_fallback(_work_item_code, _rel_path, _body):
        raise AssertionError("direct MCP HTTP fallback should not run")

    monkeypatch.setattr(laptop_bridge, "_http_worktree_write", unexpected_http_fallback)
    app = FastAPI()
    app.include_router(laptop_bridge.router)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/api/runtime-bridge/worktree/file",
        headers={"X-Service-Token": "cf-service-token"},
        json={"workItemCode": "WI-1", "path": "evidence.txt", "content": "hello"},
    )

    assert response.status_code == 503
    assert "RUNTIME_NOT_CONNECTED" in response.json()["detail"]
    assert "RUNTIME_HTTP_FALLBACK_ENABLED=true" in response.json()["detail"]
