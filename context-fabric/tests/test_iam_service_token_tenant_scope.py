import importlib
from pathlib import Path

from context_api_service.app import iam_service_token
from context_api_service.app.config import settings
import httpx
import pytest


def unsigned_jwt(payload: dict) -> str:
    import base64
    import json

    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return ".".join([part({"alg": "none", "typ": "JWT"}), part(payload), "sig"])


def test_configured_tenant_ids_for_service_token(monkeypatch):
    monkeypatch.setattr(settings, "iam_service_token_tenant_ids", " tenant-b,tenant-a,tenant-a,, ")

    assert iam_service_token.configured_tenant_ids_for_service_token() == ["tenant-a", "tenant-b"]


def test_validate_iam_service_token_tenant_scope_requires_exact_match(monkeypatch):
    monkeypatch.setattr(settings, "require_tenant_id", True)
    monkeypatch.setattr(settings, "iam_service_token_tenant_ids", "tenant-a,tenant-b")

    assert iam_service_token.validate_iam_service_token_tenant_scope(
        unsigned_jwt({"tenant_ids": ["tenant-b", "tenant-a"]})
    )
    assert not iam_service_token.validate_iam_service_token_tenant_scope(
        unsigned_jwt({"tenant_ids": ["tenant-a"]})
    )
    assert not iam_service_token.validate_iam_service_token_tenant_scope(
        unsigned_jwt({"tenant_ids": ["tenant-a", "tenant-b", "tenant-c"]})
    )
    assert not iam_service_token.validate_iam_service_token_tenant_scope(unsigned_jwt({}))


class FakeAsyncClient:
    responses: list[httpx.Response] = []
    calls: list[tuple[str, str]] = []
    timeouts: list[float] = []

    def __init__(self, timeout: float):
        self.timeout = timeout
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url: str, **kwargs):
        self.calls.append(("POST", url))
        if not self.responses:
            raise AssertionError(f"unexpected POST {url}")
        return self.responses.pop(0)


def _response(status: int, text: str) -> httpx.Response:
    return httpx.Response(status, text=text)


@pytest.mark.asyncio
async def test_mint_returns_none_when_bootstrap_login_returns_invalid_json(monkeypatch):
    iam_service_token.invalidate_iam_service_token()
    monkeypatch.setattr(settings, "iam_base_url", "http://iam.local")
    monkeypatch.setenv("IAM_BOOTSTRAP_USERNAME", "admin@singularity.local")
    monkeypatch.setenv("IAM_BOOTSTRAP_PASSWORD", "Admin1234!")
    FakeAsyncClient.responses = [_response(200, "Internal Server Error")]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setattr(iam_service_token.httpx, "AsyncClient", FakeAsyncClient)

    assert await iam_service_token._mint() is None
    assert FakeAsyncClient.calls == [("POST", "http://iam.local/auth/local/login")]
    assert FakeAsyncClient.timeouts == [iam_service_token.IAM_SERVICE_TOKEN_TIMEOUT_SEC]


@pytest.mark.asyncio
async def test_mint_returns_none_when_service_token_mint_returns_invalid_json(monkeypatch):
    iam_service_token.invalidate_iam_service_token()
    monkeypatch.setattr(settings, "iam_base_url", "http://iam.local")
    monkeypatch.setattr(settings, "require_tenant_id", False)
    monkeypatch.setenv("IAM_BOOTSTRAP_USERNAME", "admin@singularity.local")
    monkeypatch.setenv("IAM_BOOTSTRAP_PASSWORD", "Admin1234!")
    FakeAsyncClient.responses = [
        _response(200, '{"access_token":"user.jwt.token"}'),
        _response(200, "<html>not json</html>"),
    ]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setattr(iam_service_token.httpx, "AsyncClient", FakeAsyncClient)

    assert await iam_service_token._mint() is None
    assert FakeAsyncClient.calls == [
        ("POST", "http://iam.local/auth/local/login"),
        ("POST", "http://iam.local/auth/service-token"),
    ]
    assert FakeAsyncClient.timeouts == [iam_service_token.IAM_SERVICE_TOKEN_TIMEOUT_SEC]


def _reload_with_timeout(monkeypatch, value: str | None):
    if value is None:
        monkeypatch.delenv("CONTEXT_FABRIC_IAM_SERVICE_TOKEN_TIMEOUT_SEC", raising=False)
    else:
        monkeypatch.setenv("CONTEXT_FABRIC_IAM_SERVICE_TOKEN_TIMEOUT_SEC", value)
    return importlib.reload(iam_service_token)


def test_iam_service_token_timeout_is_bounded_env(monkeypatch):
    assert _reload_with_timeout(monkeypatch, None).IAM_SERVICE_TOKEN_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "bad").IAM_SERVICE_TOKEN_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "0").IAM_SERVICE_TOKEN_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "12.5").IAM_SERVICE_TOKEN_TIMEOUT_SEC == 12.5
    assert _reload_with_timeout(monkeypatch, "9999").IAM_SERVICE_TOKEN_TIMEOUT_SEC == 300.0
    monkeypatch.delenv("CONTEXT_FABRIC_IAM_SERVICE_TOKEN_TIMEOUT_SEC", raising=False)
    importlib.reload(iam_service_token)


def test_iam_service_token_mint_uses_bounded_timeout_constant():
    source = Path("services/context_api_service/app/iam_service_token.py").read_text()
    assert "from .env_config import bounded_float_env" in source
    assert "CONTEXT_FABRIC_IAM_SERVICE_TOKEN_TIMEOUT_SEC" in source
    assert (
        'IAM_SERVICE_TOKEN_TIMEOUT_SEC = bounded_float_env(\n'
        '    "CONTEXT_FABRIC_IAM_SERVICE_TOKEN_TIMEOUT_SEC",'
    ) in source
    assert "httpx.AsyncClient(timeout=IAM_SERVICE_TOKEN_TIMEOUT_SEC)" in source
    assert "httpx.AsyncClient(timeout=10.0)" not in source
