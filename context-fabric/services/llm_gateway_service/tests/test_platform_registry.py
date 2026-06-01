"""M11.a — gateway self-registration payload tests.

Guards the three bugs that previously made gateway registration a silent
no-op / 400:
  1. auth_mode must be a value the registry's zod enum accepts
     (none | bearer-iam | bearer-static | mtls) — the old code emitted the
     invalid "bearer".
  2. start_self_registration must no-op (not POST) when PLATFORM_REGISTRY_URL
     is unset, so the gateway runs standalone/locally.
  3. service_name is overridable (LLM_GATEWAY_SERVICE_NAME) so a local dev
     gateway can register under a distinct name.
"""
from __future__ import annotations

import asyncio

import pytest

from services.llm_gateway_service.app import platform_registry as reg


# Registry's accepted auth_mode enum (platform-registry/src/routes/registry.ts).
VALID_AUTH_MODES = {"none", "bearer-iam", "bearer-static", "mtls"}


def test_payload_auth_mode_is_valid_enum_with_bearer(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_GATEWAY_BEARER", "secret-bearer-token")
    monkeypatch.delenv("LLM_GATEWAY_SERVICE_NAME", raising=False)
    payload = reg.build_registration_payload()
    assert payload["auth_mode"] in VALID_AUTH_MODES
    # Bearer set → static-bearer auth, NOT the old invalid "bearer".
    assert payload["auth_mode"] == "bearer-static"
    assert payload["service_name"] == "llm-gateway"


def test_payload_auth_mode_none_without_bearer(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LLM_GATEWAY_BEARER", raising=False)
    payload = reg.build_registration_payload()
    assert payload["auth_mode"] == "none"
    assert payload["auth_mode"] in VALID_AUTH_MODES


def test_payload_local_service_name_override(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_GATEWAY_SERVICE_NAME", "llm-gateway-local")
    payload = reg.build_registration_payload()
    assert payload["service_name"] == "llm-gateway-local"


def test_payload_shape_is_registry_compatible(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LLM_GATEWAY_BEARER", raising=False)
    payload = reg.build_registration_payload()
    # Required fields of the registry registerSchema.
    for key in ("service_name", "display_name", "version", "base_url", "auth_mode"):
        assert payload.get(key), f"missing required field {key}"
    assert isinstance(payload["capabilities"], list) and payload["capabilities"]
    assert all("capability_key" in c for c in payload["capabilities"])


def test_registration_noops_without_registry_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PLATFORM_REGISTRY_URL", raising=False)
    posted: list[str] = []

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, *a, **k):
            posted.append(url)

    monkeypatch.setattr(reg.httpx, "AsyncClient", FakeClient)
    asyncio.run(reg.start_self_registration(reg.build_registration_payload()))
    # No registry URL → no HTTP, no background task.
    assert posted == []
    assert reg._heartbeat_task is None


def test_registration_posts_register_when_url_set(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PLATFORM_REGISTRY_URL", "http://registry:8090")
    monkeypatch.delenv("LLM_GATEWAY_BEARER", raising=False)
    reg._heartbeat_task = None
    posted: list[tuple[str, dict]] = []

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, json=None, headers=None):  # noqa: A002
            posted.append((url, json or {}))

            class R:
                status_code = 200
                text = ""
            return R()

    monkeypatch.setattr(reg.httpx, "AsyncClient", FakeClient)

    async def _run():
        await reg.start_self_registration(reg.build_registration_payload())
        await reg.stop_self_registration()  # cancel heartbeat so the test exits clean

    asyncio.run(_run())
    assert posted, "expected a POST to the registry"
    url, body = posted[0]
    assert url == "http://registry:8090/api/v1/register"
    assert body["service_name"] == "llm-gateway"
    assert body["auth_mode"] in VALID_AUTH_MODES
