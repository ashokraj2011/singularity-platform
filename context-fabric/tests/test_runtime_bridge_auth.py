from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import importlib
import json
from pathlib import Path
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.testclient import TestClient

from context_api_service.app import laptop_bridge
from context_api_service.app.env_config import bounded_int_env


def _b64(value: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()


def _signed_runtime_token(
    payload: object,
    *,
    secret: str = "test-secret",
    header: object | None = None,
) -> str:
    header = _b64(header if header is not None else {"alg": "HS256", "typ": "JWT"})
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


def test_hs256_runtime_jwt_rejects_non_ascii_signing_input_as_jwt_error():
    header = _b64({"alg": "HS256", "typ": "JWT"})
    token = f"{header}.é.signature"

    with pytest.raises(laptop_bridge.JWTError, match="malformed JWT"):
        laptop_bridge._verify_hs256_jwt(token, "test-secret")


def test_hs256_runtime_jwt_rejects_excessive_expiry(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", raising=False)
    module = importlib.reload(laptop_bridge)
    now = int(time.time())
    base_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
    }

    accepted = module._verify_hs256_jwt(
        _signed_runtime_token({**base_payload, "exp": now + 90 * 24 * 60 * 60}),
        "test-secret",
    )
    assert accepted["sub"] == "user-a"

    with pytest.raises(module.JWTError, match="token expiry too far in future"):
        module._verify_hs256_jwt(
            _signed_runtime_token({**base_payload, "exp": now + module._MAX_RUNTIME_TOKEN_TTL_SEC + 60}),
            "test-secret",
        )

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", str(24 * 60 * 60))
    module = importlib.reload(laptop_bridge)
    with pytest.raises(module.JWTError, match="token expiry too far in future"):
        module._verify_hs256_jwt(
            _signed_runtime_token({**base_payload, "exp": now + 2 * 24 * 60 * 60}),
            "test-secret",
        )

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", raising=False)
    importlib.reload(laptop_bridge)


def test_hs256_runtime_jwt_rejects_oversized_token(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "_MAX_RUNTIME_JWT_LEN", 16)
    token = _signed_runtime_token({
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": int(time.time()) + 60,
    })

    with pytest.raises(laptop_bridge.JWTError, match="token too long"):
        laptop_bridge._verify_hs256_jwt(token, "test-secret")


def test_runtime_bridge_token_ttl_env_defaults_fallbacks_and_clamps(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", raising=False)
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_TOKEN_TTL_SEC == 365 * 24 * 60 * 60

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", "bad")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_TOKEN_TTL_SEC == 365 * 24 * 60 * 60

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", "0")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_TOKEN_TTL_SEC == 365 * 24 * 60 * 60

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", "86400")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_TOKEN_TTL_SEC == 24 * 60 * 60

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", "999999999")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_TOKEN_TTL_SEC == 365 * 24 * 60 * 60

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_bridge_token_ttl_env_uses_bounded_helper(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", raising=False)
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC",
        default=365 * 24 * 60 * 60,
        min_value=60 * 60,
        max_value=365 * 24 * 60 * 60,
    ) == 365 * 24 * 60 * 60

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", "0")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC",
        default=365 * 24 * 60 * 60,
        min_value=60 * 60,
        max_value=365 * 24 * 60 * 60,
    ) == 365 * 24 * 60 * 60

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC", "999999999")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC",
        default=365 * 24 * 60 * 60,
        min_value=60 * 60,
        max_value=365 * 24 * 60 * 60,
    ) == 365 * 24 * 60 * 60


def test_runtime_health_metadata_env_defaults_fallbacks_and_clamps(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", raising=False)
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_HEALTH_BYTES == 64 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", "bad")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_HEALTH_BYTES == 64 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", "0")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_HEALTH_BYTES == 64 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", "4096")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_HEALTH_BYTES == 4096

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", "999999999")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_HEALTH_BYTES == 2 * 1024 * 1024

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_health_metadata_env_uses_bounded_helper(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", raising=False)
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES",
        default=64 * 1024,
        min_value=1024,
        max_value=2 * 1024 * 1024,
    ) == 64 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", "0")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES",
        default=64 * 1024,
        min_value=1024,
        max_value=2 * 1024 * 1024,
    ) == 64 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES", "999999999")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES",
        default=64 * 1024,
        min_value=1024,
        max_value=2 * 1024 * 1024,
    ) == 2 * 1024 * 1024


def test_runtime_bridge_jwt_size_env_defaults_fallbacks_and_clamps(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", raising=False)
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_JWT_LEN == 16 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", "bad")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_JWT_LEN == 16 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", "0")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_JWT_LEN == 16 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", "32768")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_JWT_LEN == 32 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", "999999")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_JWT_LEN == 128 * 1024

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_bridge_jwt_size_env_uses_bounded_helper(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", raising=False)
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES",
        default=16 * 1024,
        min_value=1024,
        max_value=128 * 1024,
    ) == 16 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", "0")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES",
        default=16 * 1024,
        min_value=1024,
        max_value=128 * 1024,
    ) == 16 * 1024

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES", "999999")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES",
        default=16 * 1024,
        min_value=1024,
        max_value=128 * 1024,
    ) == 128 * 1024


def test_runtime_bridge_heartbeat_sweep_env_defaults_fallbacks_and_clamps(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", raising=False)
    module = importlib.reload(laptop_bridge)
    assert module.HEARTBEAT_SWEEP_SEC == 30

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", "bad")
    module = importlib.reload(laptop_bridge)
    assert module.HEARTBEAT_SWEEP_SEC == 30

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", "0")
    module = importlib.reload(laptop_bridge)
    assert module.HEARTBEAT_SWEEP_SEC == 30

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", "45")
    module = importlib.reload(laptop_bridge)
    assert module.HEARTBEAT_SWEEP_SEC == 45

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", "999999")
    module = importlib.reload(laptop_bridge)
    assert module.HEARTBEAT_SWEEP_SEC == 300

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_bridge_heartbeat_sweep_env_uses_bounded_helper(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", raising=False)
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC",
        default=30,
        min_value=1,
        max_value=300,
    ) == 30

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", "0")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC",
        default=30,
        min_value=1,
        max_value=300,
    ) == 30

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC", "999999")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC",
        default=30,
        min_value=1,
        max_value=300,
    ) == 300


def test_hs256_runtime_jwt_requires_object_header_and_payload():
    now = int(time.time())
    valid_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": now + 60,
    }

    with pytest.raises(laptop_bridge.JWTError, match="bad header"):
        laptop_bridge._verify_hs256_jwt(
            _signed_runtime_token(valid_payload, header=["not-object"]),
            "test-secret",
        )

    with pytest.raises(laptop_bridge.JWTError, match="bad payload"):
        laptop_bridge._verify_hs256_jwt(
            _signed_runtime_token(["not-object"]),
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


_IDENTITY_LENGTH_ENVS = (
    "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_USER_ID_LENGTH",
    "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_ID_LENGTH",
    "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TENANT_ID_LENGTH",
    "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_TYPE_LENGTH",
    "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_DEVICE_NAME_LENGTH",
    "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_REQUEST_ID_LENGTH",
)


def test_runtime_identity_length_env_defaults_fallbacks_and_clamps(monkeypatch):
    for name in _IDENTITY_LENGTH_ENVS:
        monkeypatch.delenv(name, raising=False)
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_USER_ID_LEN == 128
    assert module._MAX_RUNTIME_ID_LEN == 128
    assert module._MAX_RUNTIME_TENANT_ID_LEN == 128
    assert module._MAX_RUNTIME_TYPE_LEN == 64
    assert module._MAX_RUNTIME_DEVICE_NAME_LEN == 200
    assert module._MAX_RUNTIME_REQUEST_ID_LEN == 128

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_USER_ID_LENGTH", "bad")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_ID_LENGTH", "0")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TENANT_ID_LENGTH", "bad")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_TYPE_LENGTH", "0")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_DEVICE_NAME_LENGTH", "bad")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_REQUEST_ID_LENGTH", "0")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_USER_ID_LEN == 128
    assert module._MAX_RUNTIME_ID_LEN == 128
    assert module._MAX_RUNTIME_TENANT_ID_LEN == 128
    assert module._MAX_RUNTIME_TYPE_LEN == 64
    assert module._MAX_RUNTIME_DEVICE_NAME_LEN == 200
    assert module._MAX_RUNTIME_REQUEST_ID_LEN == 128

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_USER_ID_LENGTH", "32")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_ID_LENGTH", "40")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TENANT_ID_LENGTH", "48")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_TYPE_LENGTH", "8")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_DEVICE_NAME_LENGTH", "64")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_REQUEST_ID_LENGTH", "32")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_USER_ID_LEN == 32
    assert module._MAX_RUNTIME_ID_LEN == 40
    assert module._MAX_RUNTIME_TENANT_ID_LEN == 48
    assert module._MAX_RUNTIME_TYPE_LEN == 8
    assert module._MAX_RUNTIME_DEVICE_NAME_LEN == 64
    assert module._MAX_RUNTIME_REQUEST_ID_LEN == 32

    for name in _IDENTITY_LENGTH_ENVS:
        monkeypatch.setenv(name, "999999")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_USER_ID_LEN == 1024
    assert module._MAX_RUNTIME_ID_LEN == 1024
    assert module._MAX_RUNTIME_TENANT_ID_LEN == 1024
    assert module._MAX_RUNTIME_TYPE_LEN == 256
    assert module._MAX_RUNTIME_DEVICE_NAME_LEN == 512
    assert module._MAX_RUNTIME_REQUEST_ID_LEN == 1024

    for name in _IDENTITY_LENGTH_ENVS:
        monkeypatch.delenv(name, raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_identity_length_env_controls_admission_and_fallbacks(monkeypatch):
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_USER_ID_LENGTH", "32")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_ID_LENGTH", "32")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TENANT_ID_LENGTH", "32")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_TYPE_LENGTH", "8")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_DEVICE_NAME_LENGTH", "24")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_REQUEST_ID_LENGTH", "32")
    module = importlib.reload(laptop_bridge)
    monkeypatch.setattr(module, "JWT_SECRET", "test-secret")

    base_payload = {
        "kind": "runtime",
        "sub": "user-a",
        "runtime_id": "runtime-a",
        "exp": int(time.time()) + 60,
        "allowed_frame_types": ["tool-run"],
    }

    with pytest.raises(module.JWTError, match="user_id too long"):
        module._verify_runtime_token(_signed_runtime_token({**base_payload, "user_id": "u" * 33}))
    with pytest.raises(module.JWTError, match="runtime_id too long"):
        module._verify_runtime_token(_signed_runtime_token({**base_payload, "runtime_id": "r" * 33}))
    with pytest.raises(module.JWTError, match="tenant_id too long"):
        module._verify_runtime_token(_signed_runtime_token({**base_payload, "tenant_id": "t" * 33}))
    with pytest.raises(module.JWTError, match="runtime_type too long"):
        module._verify_runtime_token(_signed_runtime_token({**base_payload, "runtime_type": "m" * 9}))
    with pytest.raises(module.JWTError, match="device_name too long"):
        module._verify_runtime_token(_signed_runtime_token({**base_payload, "device_name": "d" * 25}))

    metadata = module._token_authoritative_runtime_metadata(
        base_payload,
        {
            "runtime_type": "runtime-kind",
            "device_name": "display-name-that-is-too-long",
        },
    )
    assert metadata["runtime_type"] == "runtime-"[:8]
    assert metadata["device_name"] == "display-name-that-is-too"
    assert module._runtime_response_request_id({"request_id": "r" * 32}) == "r" * 32
    assert module._runtime_response_request_id({"request_id": "r" * 33}) is None

    for name in _IDENTITY_LENGTH_ENVS:
        monkeypatch.delenv(name, raising=False)
    importlib.reload(laptop_bridge)


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


def test_runtime_capability_tag_env_defaults_fallbacks_and_clamps(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", raising=False)
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_CAPABILITY_TAGS == 32
    assert module._MAX_RUNTIME_CAPABILITY_TAG_LEN == 96

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", "bad")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", "0")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_CAPABILITY_TAGS == 32
    assert module._MAX_RUNTIME_CAPABILITY_TAG_LEN == 96

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", "4")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", "12")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_CAPABILITY_TAGS == 4
    assert module._MAX_RUNTIME_CAPABILITY_TAG_LEN == 12
    assert module._runtime_capability_tag_list(["x" * 20, "a", "b", "c", "d"]) == [
        "x" * 12,
        "a",
        "b",
        "c",
    ]

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", "999999")
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", "999999")
    module = importlib.reload(laptop_bridge)
    assert module._MAX_RUNTIME_CAPABILITY_TAGS == 256
    assert module._MAX_RUNTIME_CAPABILITY_TAG_LEN == 1024

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_capability_tag_env_uses_bounded_helpers(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", raising=False)
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS",
        default=32,
        min_value=1,
        max_value=256,
    ) == 32

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", "0")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS",
        default=32,
        min_value=1,
        max_value=256,
    ) == 32

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS", "999999")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS",
        default=32,
        min_value=1,
        max_value=256,
    ) == 256

    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", raising=False)
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH",
        default=96,
        min_value=8,
        max_value=1024,
    ) == 96

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", "0")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH",
        default=96,
        min_value=8,
        max_value=1024,
    ) == 96

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH", "999999")
    assert bounded_int_env(
        "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH",
        default=96,
        min_value=8,
        max_value=1024,
    ) == 1024


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


def test_runtime_bridge_revocation_recheck_env_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", raising=False)
    assert bounded_int_env(
        "RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC",
        default=300,
        min_value=5,
        max_value=86_400,
    ) == 300

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", "not-an-int")
    assert bounded_int_env(
        "RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC",
        default=300,
        min_value=5,
        max_value=86_400,
    ) == 300

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", "1")
    assert bounded_int_env(
        "RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC",
        default=300,
        min_value=5,
        max_value=86_400,
    ) == 300

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", "600")
    assert bounded_int_env(
        "RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC",
        default=300,
        min_value=5,
        max_value=86_400,
    ) == 600

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", "999999")
    assert bounded_int_env(
        "RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC",
        default=300,
        min_value=5,
        max_value=86_400,
    ) == 86_400


def test_runtime_bridge_bool_env_parses_known_values_and_defaults(monkeypatch):
    monkeypatch.delenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", raising=False)
    assert laptop_bridge._bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", default=True) is True
    assert laptop_bridge._bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", default=False) is False

    for value in ("1", "true", "TRUE", "yes", "on"):
        monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", value)
        assert laptop_bridge._bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", default=False) is True

    for value in ("0", "false", "FALSE", "no", "off"):
        monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", value)
        assert laptop_bridge._bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", default=True) is False

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", "flase")
    assert laptop_bridge._bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", default=False) is False
    assert laptop_bridge._bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", default=True) is True


def test_runtime_bridge_revocation_fail_open_env_defaults_fallbacks_and_overrides(monkeypatch):
    for name in ("APP_ENV", "ENVIRONMENT", "NODE_ENV", "SINGULARITY_ENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", raising=False)
    module = importlib.reload(laptop_bridge)
    assert module.REVOCATION_FAIL_OPEN is True

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", "false")
    module = importlib.reload(laptop_bridge)
    assert module.REVOCATION_FAIL_OPEN is False

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", "flase")
    module = importlib.reload(laptop_bridge)
    assert module.REVOCATION_FAIL_OPEN is True

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", raising=False)
    module = importlib.reload(module)
    assert module.REVOCATION_FAIL_OPEN is False

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", "true")
    module = importlib.reload(module)
    assert module.REVOCATION_FAIL_OPEN is True

    monkeypatch.setenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", "flase")
    module = importlib.reload(module)
    assert module.REVOCATION_FAIL_OPEN is False

    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", raising=False)
    importlib.reload(laptop_bridge)


def test_runtime_http_fallback_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", raising=False)
    assert laptop_bridge.runtime_http_fallback_timeout_sec() == 180.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "bad")
    assert laptop_bridge.runtime_http_fallback_timeout_sec() == 180.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "nan")
    assert laptop_bridge.runtime_http_fallback_timeout_sec() == 180.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "0")
    assert laptop_bridge.runtime_http_fallback_timeout_sec() == 180.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "12.5")
    assert laptop_bridge.runtime_http_fallback_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "999999")
    assert laptop_bridge.runtime_http_fallback_timeout_sec() == 3600.0


def test_runtime_revocation_iam_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", raising=False)
    assert laptop_bridge.runtime_revocation_iam_timeout_sec() == 5.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", "bad")
    assert laptop_bridge.runtime_revocation_iam_timeout_sec() == 5.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", "nan")
    assert laptop_bridge.runtime_revocation_iam_timeout_sec() == 5.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", "0")
    assert laptop_bridge.runtime_revocation_iam_timeout_sec() == 5.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", "12.5")
    assert laptop_bridge.runtime_revocation_iam_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", "999999")
    assert laptop_bridge.runtime_revocation_iam_timeout_sec() == 300.0


def test_runtime_hello_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC", raising=False)
    assert laptop_bridge.runtime_hello_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC", "bad")
    assert laptop_bridge.runtime_hello_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC", "nan")
    assert laptop_bridge.runtime_hello_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC", "0")
    assert laptop_bridge.runtime_hello_timeout_sec() == 10.0

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC", "12.5")
    assert laptop_bridge.runtime_hello_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC", "999999")
    assert laptop_bridge.runtime_hello_timeout_sec() == 300.0


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


def test_runtime_health_metadata_allows_only_bounded_objects(monkeypatch):
    monkeypatch.setattr(laptop_bridge, "_MAX_RUNTIME_HEALTH_BYTES", 48)

    accepted, too_large = laptop_bridge._runtime_health_metadata({"provider": "mock", "ready": True})
    assert accepted == {"provider": "mock", "ready": True}
    assert too_large is False

    ignored, too_large = laptop_bridge._runtime_health_metadata(["not", "an", "object"])
    assert ignored is None
    assert too_large is False

    rejected, too_large = laptop_bridge._runtime_health_metadata({"blob": "x" * 80})
    assert rejected is None
    assert too_large is True


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


class FakeRevocationAsyncClient:
    timeouts: list[float] = []
    gets: list[tuple[str, dict[str, str] | None, dict[str, str] | None]] = []

    def __init__(self, timeout: float):
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, **kwargs):
        self.gets.append((url, kwargs.get("params"), kwargs.get("headers")))
        return httpx.Response(
            200,
            json={"revoked": True},
            request=httpx.Request("GET", url),
        )


def test_runtime_revocation_iam_check_uses_configured_timeout(monkeypatch):
    FakeRevocationAsyncClient.timeouts = []
    FakeRevocationAsyncClient.gets = []

    async def fake_iam_service_token():
        return "iam-token"

    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC", "12.5")
    monkeypatch.setattr(laptop_bridge.settings, "iam_base_url", "http://iam.local")
    monkeypatch.setattr(laptop_bridge, "get_iam_service_token", fake_iam_service_token)
    monkeypatch.setattr(laptop_bridge.httpx, "AsyncClient", FakeRevocationAsyncClient)

    revoked = asyncio.run(laptop_bridge._device_revoked("user-1", "device-1"))

    assert revoked is True
    assert FakeRevocationAsyncClient.timeouts == [12.5]
    assert FakeRevocationAsyncClient.gets == [
        (
            "http://iam.local/api/v1/internal/devices/status",
            {"user_id": "user-1", "device_id": "device-1"},
            {"Authorization": "Bearer iam-token"},
        )
    ]


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


class FakeFallbackAsyncClient:
    timeouts: list[float] = []
    posts: list[tuple[str, dict[str, str] | None, dict[str, object] | None]] = []
    puts: list[tuple[str, dict[str, str] | None, dict[str, str] | None, dict[str, object] | None]] = []

    def __init__(self, timeout: float):
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url: str, **kwargs):
        self.posts.append((url, kwargs.get("headers"), kwargs.get("json")))
        return httpx.Response(
            200,
            json={"success": True, "data": {"output": {"pushed": True}}},
            request=httpx.Request("POST", url),
        )

    async def put(self, url: str, **kwargs):
        self.puts.append((url, kwargs.get("params"), kwargs.get("headers"), kwargs.get("json")))
        return httpx.Response(
            200,
            json={"success": True, "data": {"path": "evidence.txt"}},
            request=httpx.Request("PUT", url),
        )


def test_runtime_http_finish_branch_fallback_uses_configured_timeout(monkeypatch):
    FakeFallbackAsyncClient.timeouts = []
    FakeFallbackAsyncClient.posts = []
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "12.5")
    monkeypatch.setenv("MCP_SERVER_URL", "http://mcp.local")
    monkeypatch.setenv("MCP_BEARER_TOKEN", "mcp-token")
    monkeypatch.setattr(laptop_bridge.httpx, "AsyncClient", FakeFallbackAsyncClient)

    result = asyncio.run(laptop_bridge._http_finish_branch({"message": "done"}))

    assert result == {"output": {"pushed": True}}
    assert FakeFallbackAsyncClient.timeouts == [12.5]
    assert FakeFallbackAsyncClient.posts == [
        (
            "http://mcp.local/mcp/work/finish-branch",
            {"content-type": "application/json", "authorization": "Bearer mcp-token"},
            {"message": "done"},
        )
    ]


def test_runtime_http_worktree_write_fallback_uses_configured_timeout(monkeypatch):
    FakeFallbackAsyncClient.timeouts = []
    FakeFallbackAsyncClient.puts = []
    monkeypatch.setenv("CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC", "12.5")
    monkeypatch.setenv("MCP_SERVER_URL", "http://mcp.local")
    monkeypatch.setenv("MCP_BEARER_TOKEN", "mcp-token")
    monkeypatch.setattr(laptop_bridge.httpx, "AsyncClient", FakeFallbackAsyncClient)

    result = asyncio.run(
        laptop_bridge._http_worktree_write("WI-1", "evidence.txt", {"content": "hello"})
    )

    assert result == {"path": "evidence.txt"}
    assert FakeFallbackAsyncClient.timeouts == [12.5]
    assert FakeFallbackAsyncClient.puts == [
        (
            "http://mcp.local/mcp/worktree/WI-1/file",
            {"path": "evidence.txt"},
            {"content-type": "application/json", "authorization": "Bearer mcp-token"},
            {"content": "hello"},
        )
    ]


def test_runtime_http_fallback_uses_bounded_timeout_helper():
    source_path = Path(__file__).resolve().parents[1] / "services/context_api_service/app/laptop_bridge.py"
    source = source_path.read_text()

    assert "CONTEXT_FABRIC_RUNTIME_HTTP_FALLBACK_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_REVOCATION_IAM_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_HELLO_TIMEOUT_SEC" in source
    assert "RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_JWT_BYTES" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TOKEN_TTL_SEC" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_HEALTH_BYTES" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_HEARTBEAT_SWEEP_SEC" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAGS" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_CAPABILITY_TAG_LENGTH" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_USER_ID_LENGTH" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_ID_LENGTH" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_TENANT_ID_LENGTH" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_RUNTIME_TYPE_LENGTH" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_DEVICE_NAME_LENGTH" in source
    assert "CONTEXT_FABRIC_RUNTIME_BRIDGE_MAX_REQUEST_ID_LENGTH" in source
    assert "_MAX_RUNTIME_JWT_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_TOKEN_TTL_SEC = bounded_int_env(" in source
    assert "_MAX_RUNTIME_HEALTH_BYTES = bounded_int_env(" in source
    assert "HEARTBEAT_SWEEP_SEC = bounded_int_env(" in source
    assert 'REVOCATION_FAIL_OPEN = _bool_env("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN"' in source
    assert "_MAX_RUNTIME_CAPABILITY_TAGS = bounded_int_env(" in source
    assert "_MAX_RUNTIME_CAPABILITY_TAG_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_USER_ID_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_ID_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_TENANT_ID_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_TYPE_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_DEVICE_NAME_LEN = bounded_int_env(" in source
    assert "_MAX_RUNTIME_REQUEST_ID_LEN = bounded_int_env(" in source
    assert "httpx.AsyncClient(timeout=runtime_revocation_iam_timeout_sec())" in source
    assert "httpx.AsyncClient(timeout=runtime_http_fallback_timeout_sec())" in source
    assert "asyncio.wait_for(ws.receive_text(), timeout=runtime_hello_timeout_sec())" in source
    assert "asyncio.wait_for(ws.receive_text(), timeout=10)" not in source
    assert 'not in ("0", "false", "no")' not in source
    assert "token expiry too far in future" in source
    assert "_runtime_health_metadata(hello.get(\"health\"))" in source
    assert "_runtime_health_metadata(frame.get(\"health\"))" in source
    assert "runtime health too large" in source
    assert "\n_MAX_RUNTIME_JWT_LEN = 16 * 1024" not in source
    assert "\nHEARTBEAT_SWEEP_SEC = 30" not in source
    assert "\n_MAX_RUNTIME_CAPABILITY_TAGS = 32" not in source
    assert "\n_MAX_RUNTIME_CAPABILITY_TAG_LEN = 96" not in source
    assert "\n_MAX_RUNTIME_USER_ID_LEN = 128" not in source
    assert "\n_MAX_RUNTIME_ID_LEN = 128" not in source
    assert "\n_MAX_RUNTIME_TENANT_ID_LEN = 128" not in source
    assert "\n_MAX_RUNTIME_TYPE_LEN = 64" not in source
    assert "\n_MAX_RUNTIME_DEVICE_NAME_LEN = 200" not in source
    assert "\n_MAX_RUNTIME_REQUEST_ID_LEN = 128" not in source
    assert "httpx.AsyncClient(timeout=5.0)" not in source
    assert "httpx.AsyncClient(timeout=180.0)" not in source
