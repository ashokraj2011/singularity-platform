"""Unit tests for the Git credential broker (P0 #2) — deterministic logic only.

The App-JWT signing (RS256, needs `cryptography`) and the installation-token mint
(network) are verified separately against a mocked GitHub API; here we cover the
pure helpers + the hard pre-prod gate, which need no DB / network / crypto.
"""
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
