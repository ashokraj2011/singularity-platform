from __future__ import annotations

import asyncio
import importlib
from pathlib import Path

import httpx
import pytest

from context_api_service.app import healthz_strict

_ENV_NAMES = [
    "CONTEXT_FABRIC_STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC",
    "CONTEXT_FABRIC_STRICT_HEALTH_IAM_TIMEOUT_SEC",
    "CONTEXT_FABRIC_STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC",
    "CONTEXT_FABRIC_STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC",
]


@pytest.fixture(autouse=True)
def restore_healthz_defaults(monkeypatch):
    yield
    for name in _ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    importlib.reload(healthz_strict)


def _reload_healthz(monkeypatch, values: dict[str, str | None]):
    for name in _ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    return importlib.reload(healthz_strict)


def test_strict_health_timeout_env_defaults_and_bounds(monkeypatch):
    module = _reload_healthz(monkeypatch, {})
    assert module.STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC == 3
    assert module.STRICT_HEALTH_IAM_TIMEOUT_SEC == 3.0
    assert module.STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC == 5.0
    assert module.STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC == 3.0

    module = _reload_healthz(
        monkeypatch,
        {
            "CONTEXT_FABRIC_STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC": "bad",
            "CONTEXT_FABRIC_STRICT_HEALTH_IAM_TIMEOUT_SEC": "nan",
            "CONTEXT_FABRIC_STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC": "0",
            "CONTEXT_FABRIC_STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC": "999999",
        },
    )
    assert module.STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC == 3
    assert module.STRICT_HEALTH_IAM_TIMEOUT_SEC == 3.0
    assert module.STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC == 5.0
    assert module.STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC == 300.0

    module = _reload_healthz(
        monkeypatch,
        {
            "CONTEXT_FABRIC_STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC": "42",
            "CONTEXT_FABRIC_STRICT_HEALTH_IAM_TIMEOUT_SEC": "12.5",
            "CONTEXT_FABRIC_STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC": "13.5",
            "CONTEXT_FABRIC_STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC": "14.5",
        },
    )
    assert module.STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC == 42
    assert module.STRICT_HEALTH_IAM_TIMEOUT_SEC == 12.5
    assert module.STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC == 13.5
    assert module.STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC == 14.5


class FakeStrictHealthAsyncClient:
    timeouts: list[float] = []
    gets: list[str] = []
    posts: list[tuple[str, dict[str, str]]] = []

    def __init__(self, timeout: float):
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str):
        self.gets.append(url)
        return httpx.Response(200, json={"ok": True}, request=httpx.Request("GET", url))

    async def post(self, url: str, **kwargs):
        self.posts.append((url, kwargs.get("json")))
        return httpx.Response(
            200,
            json={"access_token": "test-token"},
            request=httpx.Request("POST", url),
        )


def test_strict_health_http_checks_use_configured_timeouts(monkeypatch):
    module = _reload_healthz(
        monkeypatch,
        {
            "CONTEXT_FABRIC_STRICT_HEALTH_IAM_TIMEOUT_SEC": "12.5",
            "CONTEXT_FABRIC_STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC": "13.5",
            "CONTEXT_FABRIC_STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC": "14.5",
        },
    )
    FakeStrictHealthAsyncClient.timeouts = []
    FakeStrictHealthAsyncClient.gets = []
    FakeStrictHealthAsyncClient.posts = []
    monkeypatch.setattr(module.httpx, "AsyncClient", FakeStrictHealthAsyncClient)
    monkeypatch.setattr(module.settings, "iam_base_url", "http://iam.local/api/v1")
    monkeypatch.setenv("IAM_BOOTSTRAP_USERNAME", "admin@singularity.local")
    monkeypatch.setenv("IAM_BOOTSTRAP_PASSWORD", "Admin1234!")
    monkeypatch.setenv("AUDIT_GOV_URL", "http://audit.local")

    iam = asyncio.run(module._check_iam_reachable())
    bootstrap = asyncio.run(module._check_iam_bootstrap_works())
    audit = asyncio.run(module._check_audit_gov_reachable())

    assert iam.ok is True
    assert bootstrap.ok is True
    assert audit.ok is True
    assert FakeStrictHealthAsyncClient.timeouts == [12.5, 13.5, 14.5]
    assert FakeStrictHealthAsyncClient.gets == [
        "http://iam.local/api/v1/health",
        "http://audit.local/health",
    ]
    assert FakeStrictHealthAsyncClient.posts == [
        (
            "http://iam.local/api/v1/auth/local/login",
            {"email": "admin@singularity.local", "password": "Admin1234!"},
        )
    ]


def test_strict_health_uses_bounded_timeout_constants(monkeypatch):
    source_path = Path(__file__).resolve().parents[1] / "services/context_api_service/app/healthz_strict.py"
    source = source_path.read_text()

    assert "from .env_config import bounded_float_env, bounded_int_env" in source
    assert "CONTEXT_FABRIC_STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_STRICT_HEALTH_IAM_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC" in source
    assert "connect_timeout=STRICT_HEALTH_DB_CONNECT_TIMEOUT_SEC" in source
    assert "httpx.AsyncClient(timeout=STRICT_HEALTH_IAM_TIMEOUT_SEC)" in source
    assert "httpx.AsyncClient(timeout=STRICT_HEALTH_IAM_BOOTSTRAP_TIMEOUT_SEC)" in source
    assert "httpx.AsyncClient(timeout=STRICT_HEALTH_AUDIT_GOV_TIMEOUT_SEC)" in source
    assert "connect_timeout=3" not in source
    assert "httpx.AsyncClient(timeout=3.0)" not in source
    assert "httpx.AsyncClient(timeout=5.0)" not in source
