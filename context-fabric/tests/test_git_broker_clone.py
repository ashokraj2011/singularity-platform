"""P0 #2 — Git credential broker (clone path) unit tests.

Pins broker_git_credential: the gate (GIT_CREDENTIAL_BROKER_ENABLED), the
graceful misses (repo/tenant absent), and the happy path — importantly that the
clone path's `sourceUri` is resolved as the repo and the operation + identity are
forwarded to IAM. The token is never logged (asserted implicitly: only the
returned dict carries it).

Run with (the repo conftest pulls sibling-service packages needing the full
install, so skip it here):
    cd context-fabric && PYTHONPATH=services:shared \
        python3 -m pytest tests/test_git_broker_clone.py -q --noconftest
"""
from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
from unittest.mock import patch

import pytest

from context_api_service.app import git_broker


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def reset_git_broker_module(monkeypatch):
    yield
    monkeypatch.delenv("CONTEXT_FABRIC_GIT_BROKER_TIMEOUT_SEC", raising=False)
    importlib.reload(git_broker)


def _reload_with_timeout(monkeypatch, value: str | None):
    if value is None:
        monkeypatch.delenv("CONTEXT_FABRIC_GIT_BROKER_TIMEOUT_SEC", raising=False)
    else:
        monkeypatch.setenv("CONTEXT_FABRIC_GIT_BROKER_TIMEOUT_SEC", value)
    return importlib.reload(git_broker)


def test_git_broker_timeout_is_bounded_env(monkeypatch):
    assert _reload_with_timeout(monkeypatch, None).GIT_BROKER_TIMEOUT_SEC == 20.0
    assert _reload_with_timeout(monkeypatch, "bad").GIT_BROKER_TIMEOUT_SEC == 20.0
    assert _reload_with_timeout(monkeypatch, "0").GIT_BROKER_TIMEOUT_SEC == 20.0
    assert _reload_with_timeout(monkeypatch, "nan").GIT_BROKER_TIMEOUT_SEC == 20.0
    assert _reload_with_timeout(monkeypatch, "12.5").GIT_BROKER_TIMEOUT_SEC == 12.5
    assert _reload_with_timeout(monkeypatch, "9999").GIT_BROKER_TIMEOUT_SEC == 300.0


def test_git_broker_uses_bounded_timeout_constant():
    source = Path("services/context_api_service/app/git_broker.py").read_text()
    assert "from .env_config import bounded_float_env" in source
    assert "CONTEXT_FABRIC_GIT_BROKER_TIMEOUT_SEC" in source
    assert (
        'GIT_BROKER_TIMEOUT_SEC = bounded_float_env(\n'
        '    "CONTEXT_FABRIC_GIT_BROKER_TIMEOUT_SEC",'
    ) in source
    assert "httpx.AsyncClient(timeout=GIT_BROKER_TIMEOUT_SEC)" in source
    assert "httpx.AsyncClient(timeout=20.0)" not in source


def test_broker_disabled_returns_none(monkeypatch):
    monkeypatch.delenv("GIT_CREDENTIAL_BROKER_ENABLED", raising=False)
    out = _run(git_broker.broker_git_credential({"sourceUri": "https://github.com/o/r", "tenantId": "t"}, "clone"))
    assert out is None


def test_broker_missing_repo_or_tenant_returns_none(monkeypatch):
    monkeypatch.setenv("GIT_CREDENTIAL_BROKER_ENABLED", "true")
    assert _run(git_broker.broker_git_credential({"tenantId": "t"}, "clone")) is None  # no repo
    assert _run(git_broker.broker_git_credential({"sourceUri": "https://github.com/o/r"}, "clone")) is None  # no tenant


def test_broker_issues_credential_resolving_repo_from_source_uri(monkeypatch):
    module = _reload_with_timeout(monkeypatch, "12.5")
    monkeypatch.setenv("GIT_CREDENTIAL_BROKER_ENABLED", "true")
    captured: dict = {}

    class FakeResp:
        status_code = 200

        def json(self):
            return {"token": "ghs_secret", "issuanceId": "iss-1", "allowedOperation": "clone", "repo": "o/r"}

    class FakeClient:
        def __init__(self, *a, **k):
            captured["timeout"] = k.get("timeout")
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return FakeResp()

    async def fake_token():
        return "svc-jwt"

    with patch.object(module.httpx, "AsyncClient", FakeClient), patch.object(module, "get_iam_service_token", fake_token):
        cred = _run(
            module.broker_git_credential(
                {
                    "sourceUri": "https://github.com/o/r",
                    "tenant_id": "t-1",
                    "user_id": "u-1",
                    "capability_id": "c-1",
                    "runId": "run-1",
                },
                "clone",
                grant_nonce="nonce-1",
            )
        )

    assert cred is not None and cred["token"] == "ghs_secret"
    assert captured["timeout"] == 12.5
    # sourceUri is resolved as the repo (the clone path names the repo that way).
    assert captured["json"]["repo"] == "https://github.com/o/r"
    assert captured["json"]["operation"] == "clone"
    assert captured["json"]["tenantId"] == "t-1"
    assert captured["json"]["userId"] == "u-1"
    assert captured["json"]["capabilityId"] == "c-1"
    assert captured["json"]["grantNonce"] == "nonce-1"
    assert captured["url"].endswith("/internal/git/credentials/issue")
    assert captured["headers"]["Authorization"] == "Bearer svc-jwt"


def test_clone_credential_memoized_once_per_run(monkeypatch):
    """clone_credential_for_run brokers ONCE per (run, repo) — the second call in
    the same run (e.g. code-context then a tool-run) reuses the memo instead of
    minting a fresh IAM credential."""
    monkeypatch.setenv("GIT_CREDENTIAL_BROKER_ENABLED", "true")
    git_broker._clone_cred_cache.clear()
    calls = {"n": 0}

    class FakeResp:
        status_code = 200

        def json(self):
            return {"token": "ghs_secret", "allowedOperation": "clone"}

    class FakeClient:
        def __init__(self, *a, **k): ...
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, *a, **k):
            calls["n"] += 1
            return FakeResp()

    async def fake_token():
        return "svc-jwt"

    rc = {"sourceUri": "https://github.com/o/r", "tenant_id": "t-1", "runId": "run-1"}
    try:
        with patch.object(git_broker.httpx, "AsyncClient", FakeClient), patch.object(git_broker, "get_iam_service_token", fake_token):
            c1 = _run(git_broker.clone_credential_for_run(rc))
            c2 = _run(git_broker.clone_credential_for_run(rc))
        assert c1 is not None and c2 is not None
        assert c1["token"] == "ghs_secret"
        assert calls["n"] == 1  # second call served from the per-run memo
    finally:
        git_broker._clone_cred_cache.clear()


def test_broker_iam_failure_returns_none(monkeypatch):
    monkeypatch.setenv("GIT_CREDENTIAL_BROKER_ENABLED", "true")

    class FakeResp:
        status_code = 403
        text = "no git grant"

        def json(self):  # pragma: no cover - not reached on failure
            return {}

    class FakeClient:
        def __init__(self, *a, **k): ...
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, *a, **k):
            return FakeResp()

    async def fake_token():
        return "svc-jwt"

    with patch.object(git_broker.httpx, "AsyncClient", FakeClient), patch.object(git_broker, "get_iam_service_token", fake_token):
        out = _run(git_broker.broker_git_credential({"sourceUri": "https://github.com/o/r", "tenantId": "t-1"}, "clone"))
    assert out is None
