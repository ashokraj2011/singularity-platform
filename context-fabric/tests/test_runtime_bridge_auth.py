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
        "allowed_frame_types": ["tool-run"],
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
        "allowed_frame_types": ["tool-run"],
    }

    with_runtime_id = laptop_bridge._verify_runtime_token(
        _signed_runtime_token({**base_payload, "runtime_id": "runtime-a"})
    )
    with_device_id = laptop_bridge._verify_runtime_token(
        _signed_runtime_token({**base_payload, "device_id": "device-a"})
    )

    assert with_runtime_id["runtime_id"] == "runtime-a"
    assert with_device_id["device_id"] == "device-a"


@pytest.mark.parametrize(
    "claim,max_len",
    [
        ("sub", 128),
        ("user_id", 128),
        ("runtime_id", 128),
        ("device_id", 128),
        ("tenant_id", 128),
        ("tenant", 128),
        ("org_id", 128),
        ("runtime_type", 64),
        ("device_name", 200),
    ],
)
def test_runtime_token_rejects_oversized_identity_and_display_claims(monkeypatch, claim, max_len):
    monkeypatch.setattr(laptop_bridge, "JWT_SECRET", "test-secret")
    payload = {
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": int(time.time()) + 60,
        "allowed_frame_types": ["tool-run"],
        claim: "x" * (max_len + 1),
    }

    with pytest.raises(laptop_bridge.JWTError, match=f"{claim} too long"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token(payload))


def test_runtime_token_requires_allowed_frame_types(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "JWT_SECRET", "test-secret")
    base_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": int(time.time()) + 60,
    }

    with pytest.raises(laptop_bridge.JWTError, match="missing allowed_frame_types"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token(base_payload))

    with pytest.raises(laptop_bridge.JWTError, match="missing allowed_frame_types"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token({
            **base_payload,
            "allowed_frame_types": "tool-run",
        }))

    with pytest.raises(laptop_bridge.JWTError, match="missing allowed_frame_types"):
        laptop_bridge._verify_runtime_token(_signed_runtime_token({
            **base_payload,
            "allowed_frame_types": ["unknown-frame", ""],
        }))


def test_runtime_token_accepts_known_allowed_frame_types(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "JWT_SECRET", "test-secret")
    claims = laptop_bridge._verify_runtime_token(_signed_runtime_token({
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": int(time.time()) + 60,
        "allowed_frame_types": ["tool-run", "model-run"],
    }))

    assert claims["allowed_frame_types"] == ["tool-run", "model-run"]


def test_runtime_frame_list_filters_unknown_blank_and_duplicate_frames():
    assert laptop_bridge._runtime_frame_list([
        " tool-run ",
        "unknown-frame",
        "",
        "model-run",
        "tool-run",
        123,
    ]) == ["tool-run", "model-run"]


def test_runtime_capability_tag_list_canonicalizes_and_bounds_tags():
    long_tag = "x" * 120
    raw = [
        " mcp ",
        "",
        "tools",
        "mcp",
        long_tag,
        *[f"tag-{i}" for i in range(40)],
    ]

    tags = laptop_bridge._runtime_capability_tag_list(raw)

    assert tags[:3] == ["mcp", "tools", long_tag[:96]]
    assert len(tags) == 32
    assert tags.count("mcp") == 1
    assert "" not in tags
    assert laptop_bridge._runtime_capability_tag_list("mcp") == []


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


@pytest.mark.parametrize("value", [True, 1, "1", "true", "TRUE", "yes", "on"])
def test_runtime_shared_claim_accepts_explicit_true_values(value):
    assert laptop_bridge._runtime_claims_shared({"shared": value}) is True


@pytest.mark.parametrize("value", [False, 0, "0", "false", "FALSE", "no", "off", "", None])
def test_runtime_shared_claim_rejects_false_like_values(value):
    assert laptop_bridge._runtime_claims_shared({"shared": value}) is False


@pytest.mark.parametrize("scope", ["tenant", "shared", "TENANT", " shared "])
def test_runtime_shared_claim_accepts_shared_scopes(scope):
    assert laptop_bridge._runtime_claims_shared({"shared": False, "runtime_scope": scope}) is True


@pytest.mark.parametrize("scope", ["user", "personal", "", None])
def test_runtime_shared_claim_rejects_personal_scopes(scope):
    assert laptop_bridge._runtime_claims_shared({"shared": "false", "runtime_scope": scope}) is False


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


def test_runtime_metadata_bounds_legacy_hello_display_fallbacks():
    metadata = laptop_bridge._token_authoritative_runtime_metadata(
        {
            "kind": "device",
            "sub": "user-legacy",
            "device_id": "legacy-device",
        },
        {
            "type": "hello",
            "runtime_type": "r" * 80,
            "device_name": "d" * 240,
        },
    )

    assert metadata["runtime_type"] == "r" * 64
    assert metadata["device_name"] == "d" * 200


def test_runtime_frame_size_guard_counts_utf8_bytes(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "MAX_PAYLOAD_BYTES", 4)

    assert laptop_bridge._runtime_frame_size("abcd") == 4
    assert laptop_bridge._runtime_frame_too_large("abcd") is False
    assert laptop_bridge._runtime_frame_size("🙂") == 4
    assert laptop_bridge._runtime_frame_too_large("🙂x") is True


def test_runtime_response_request_id_bounds_and_normalizes():
    assert laptop_bridge._runtime_response_request_id({"request_id": "req-123"}) == "req-123"
    assert laptop_bridge._runtime_response_request_id({"request_id": ""}) is None
    assert laptop_bridge._runtime_response_request_id({"request_id": "   "}) is None
    assert laptop_bridge._runtime_response_request_id({"request_id": "r" * 128}) == "r" * 128
    assert laptop_bridge._runtime_response_request_id({"request_id": "r" * 129}) is None
    assert laptop_bridge._runtime_response_request_id({"request_id": 123}) is None
    assert laptop_bridge._runtime_response_request_id({}) is None


def test_runtime_json_object_accepts_only_json_objects():
    obj, err = laptop_bridge._runtime_json_object('{"type":"heartbeat"}')
    assert obj == {"type": "heartbeat"}
    assert err is None

    obj, err = laptop_bridge._runtime_json_object("{bad-json")
    assert obj is None
    assert err == "bad-json"

    for raw in ('["heartbeat"]', '"heartbeat"', "null", "123"):
        obj, err = laptop_bridge._runtime_json_object(raw)
        assert obj is None
        assert err == "not-object"


def test_runtime_revocation_identity_prefers_device_id_then_runtime_id():
    assert laptop_bridge._runtime_revocation_identity({
        "kind": "device",
        "sub": "user-device",
        "device_id": "device-a",
    }) == ("user-device", "device-a")

    assert laptop_bridge._runtime_revocation_identity({
        "kind": "runtime",
        "sub": "user-runtime",
        "runtime_id": "runtime-a",
    }) == ("user-runtime", "runtime-a")

    assert laptop_bridge._runtime_revocation_identity({
        "kind": "runtime",
        "user_id": "user-claim",
        "sub": "user-sub",
        "device_id": "device-a",
        "runtime_id": "runtime-a",
    }) == ("user-claim", "device-a")


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
