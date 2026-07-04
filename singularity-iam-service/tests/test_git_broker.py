"""Unit tests for the Git credential broker (P0 #2) — deterministic logic only.

The App-JWT signing (RS256, needs `cryptography`) and the installation-token mint
(network) are verified separately against a mocked GitHub API; here we cover the
pure helpers + the hard pre-prod gate, which need no DB / network / crypto.
"""
import asyncio

import pytest

from app.git import github_app
from app.git.routes import _normalize_repo


def test_permissions_for_operation():
    assert github_app._permissions_for("push") == {"contents": "write"}
    assert github_app._permissions_for("clone") == {"contents": "read"}
    assert github_app._permissions_for("read") == {"contents": "read"}
    assert github_app._permissions_for("pr") == {"pull_requests": "write"}
    assert github_app._permissions_for("comment") == {"pull_requests": "write"}
    # Unknown operation defaults to least privilege (read).
    assert github_app._permissions_for("wat") == {"contents": "read"}


def test_token_fingerprint_does_not_leak_token():
    token = "ghs_supersecrettoken_AAAA1111"
    fp = github_app.token_fingerprint(token)
    assert fp.startswith("sha256:")
    assert token not in fp
    assert fp == github_app.token_fingerprint(token)  # deterministic
    assert github_app.token_fingerprint("other") != fp


def test_normalize_repo_forms():
    assert _normalize_repo("owner/name") == "owner/name"
    assert _normalize_repo("https://github.com/owner/name") == "owner/name"
    assert _normalize_repo("https://github.com/owner/name.git") == "owner/name"
    assert _normalize_repo("git@github.com:owner/name.git") == "owner/name"
    assert _normalize_repo("  owner/name/  ") == "owner/name"


def test_plaintext_storage_gate_blocks_prod(monkeypatch):
    for var in ("APP_ENV", "ENVIRONMENT", "NODE_ENV", "SINGULARITY_ENV"):
        monkeypatch.delenv(var, raising=False)
    # Dev/local: allowed.
    github_app.assert_plaintext_storage_allowed()
    # Production-class: refused (the hard pre-prod gate).
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError):
        github_app.assert_plaintext_storage_allowed()


def test_mint_installation_token_rejects_invalid_github_json(monkeypatch):
    monkeypatch.setattr(github_app, "build_app_jwt", lambda app_id, private_key: "app-jwt")
    monkeypatch.setattr(github_app, "_GITHUB_API_URL", "https://api.github.test")

    class FakeResponse:
        status_code = 201
        text = "Internal Server Error"

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, headers, json):
            return FakeResponse()

    monkeypatch.setattr(github_app.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match=r"GitHub installation-token mint returned invalid JSON .*Internal Server Error"):
        asyncio.run(github_app.mint_installation_token(
            app_id="1",
            installation_id="2",
            private_key="not-used",
            repo="owner/repo",
            operation="clone",
        ))


def test_mint_installation_token_rejects_non_object_github_json(monkeypatch):
    monkeypatch.setattr(github_app, "build_app_jwt", lambda app_id, private_key: "app-jwt")
    monkeypatch.setattr(github_app, "_GITHUB_API_URL", "https://api.github.test")

    class FakeResponse:
        status_code = 201
        text = '["not", "an", "object"]'

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, headers, json):
            return FakeResponse()

    monkeypatch.setattr(github_app.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match=r"GitHub installation-token mint returned invalid JSON object"):
        asyncio.run(github_app.mint_installation_token(
            app_id="1",
            installation_id="2",
            private_key="not-used",
            repo="owner/repo",
            operation="clone",
        ))
