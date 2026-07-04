from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.testclient import TestClient

from context_api_service.app import laptop_bridge


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()


def _signed_runtime_token(payload: dict, *, secret: str = "test-secret") -> str:
    header = _b64({"alg": "HS256", "typ": "JWT"})
    body = _b64(payload)
    sig = hmac.new(secret.encode(), f"{header}.{body}".encode("ascii"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    return f"{header}.{body}.{sig_b64}"


def test_hs256_runtime_jwt_requires_numeric_expiry():
    now = int(time.time())
    base_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
    }

    valid = laptop_bridge._verify_hs256_jwt(
        _signed_runtime_token({**base_payload, "exp": now + 60}),
        "test-secret",
    )
    assert valid["sub"] == "user-a"

    with pytest.raises(laptop_bridge.JWTError, match="missing or invalid exp"):
        laptop_bridge._verify_hs256_jwt(_signed_runtime_token(base_payload), "test-secret")

    with pytest.raises(laptop_bridge.JWTError, match="missing or invalid exp"):
        laptop_bridge._verify_hs256_jwt(
            _signed_runtime_token({**base_payload, "exp": str(now + 60)}),
            "test-secret",
        )


def test_hs256_runtime_jwt_rejects_expired_token():
    token = _signed_runtime_token({
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": int(time.time()) - 1,
    })

    with pytest.raises(laptop_bridge.JWTError, match="token expired"):
        laptop_bridge._verify_hs256_jwt(token, "test-secret")


def test_runtime_token_requires_nonblank_runtime_identity(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "JWT_SECRET", "test-secret")
    base_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "exp": int(time.time()) + 60,
    }

    with pytest.raises(laptop_bridge.JWTError, match="missing runtime_id"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token(base_payload))

    with pytest.raises(laptop_bridge.JWTError, match="missing runtime_id"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token({
            **base_payload,
            "runtime_id": "   ",
            "device_id": "",
        }))


def test_runtime_token_accepts_runtime_id_or_device_id(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "JWT_SECRET", "test-secret")
    base_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "exp": int(time.time()) + 60,
    }

    with_runtime_id = laptop_bridge._verify_runtime_token(
        _signed_runtime_token({**base_payload, "runtime_id": "runtime-a"})
    )
    with_device_id = laptop_bridge._verify_runtime_token(
        _signed_runtime_token({**base_payload, "device_id": "device-a"})
    )

    assert with_runtime_id["runtime_id"] == "runtime-a"
    assert with_device_id["device_id"] == "device-a"


def test_device_token_still_requires_device_id(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "JWT_SECRET", "test-secret")
    base_payload = {
        "kind": "device",
        "sub": "user-a",
        "exp": int(time.time()) + 60,
    }

    with pytest.raises(laptop_bridge.JWTError, match="missing device_id"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token(base_payload))

    claims = laptop_bridge._verify_runtime_token(
        _signed_runtime_token({**base_payload, "device_id": "device-a"})
    )
    assert claims["device_id"] == "device-a"


def test_runtime_metadata_uses_token_claims_over_spoofed_hello():
    metadata = laptop_bridge._token_authoritative_runtime_metadata(
        {
            "kind": "runtime",
            "sub": "user-real",
            "tenant_id": "tenant-real",
            "runtime_id": "runtime-real",
            "runtime_type": "mcp",
            "device_name": "trusted-runtime-name",
        },
        {
            "type": "hello",
            "user_id": "user-spoof",
            "tenant_id": "tenant-spoof",
            "runtime_id": "runtime-spoof",
            "device_id": "device-spoof",
            "runtime_type": "admin-runtime",
            "device_name": "confusing-name",
        },
    )

    assert metadata == {
        "user_id": "user-real",
        "tenant_id": "tenant-real",
        "runtime_id": "runtime-real",
        "runtime_type": "mcp",
        "device_name": "trusted-runtime-name",
    }


def test_runtime_metadata_allows_legacy_hello_display_fallbacks():
    metadata = laptop_bridge._token_authoritative_runtime_metadata(
        {
            "kind": "device",
            "sub": "user-legacy",
            "device_id": "legacy-device",
        },
        {
            "type": "hello",
            "runtime_type": "mcp",
            "device_name": "legacy-laptop",
        },
    )

    assert metadata == {
        "user_id": "user-legacy",
        "tenant_id": "",
        "runtime_id": "legacy-device",
        "runtime_type": "mcp",
        "device_name": "legacy-laptop",
    }


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
