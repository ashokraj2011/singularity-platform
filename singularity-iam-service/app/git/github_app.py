"""GitHub App credential minting for the Git broker (P0 #2).

Mints short-lived **installation access tokens** scoped to a single repository,
for one git operation, used in-memory by the runtime and then discarded. v0
stores the App private key in plaintext (``git_provider_connections.private_key``)
— a HARD pre-prod gate: ``assert_plaintext_storage_allowed()`` refuses to operate
in production-class environments until the key moves to KMS/Vault.

The GitHub API base is read from ``GITHUB_API_URL`` (default api.github.com) so
unit tests can point it at a mock server.

Requires PyJWT with RS256 support (the ``cryptography`` extra) for the App JWT.
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Any

import httpx
import jwt

from app.config import _is_prod_env

log = logging.getLogger(__name__)

# Loud, once-at-import warning that plaintext-v0 key storage is active.
log.warning(
    "Git credential broker: GitHub App private keys are stored PLAINTEXT (v0). "
    "Pre-prod gate — move to KMS/Vault before any non-dev deployment."
)

_GITHUB_API_URL = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")


def assert_plaintext_storage_allowed() -> None:
    """Hard pre-prod gate: the plaintext-App-key broker must not run in
    production-class envs. Raises RuntimeError when it would."""
    if _is_prod_env():
        raise RuntimeError(
            "Git credential broker is disabled in production-class environments: "
            "plaintext App-key storage (v0) requires a KMS/Vault migration first."
        )


def _permissions_for(operation: str) -> dict[str, str]:
    """Minimal GitHub App permission set for a git operation."""
    op = (operation or "").lower()
    if op == "push":
        return {"contents": "write"}
    if op in ("clone", "read"):
        return {"contents": "read"}
    if op in ("pr", "comment"):
        return {"pull_requests": "write"}
    return {"contents": "read"}


def build_app_jwt(app_id: str, private_key: str) -> str:
    """A short-lived (≈9 min) RS256 App JWT, signed with the App private key.
    `iat` is backdated 60s to tolerate clock skew (GitHub requirement)."""
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 540, "iss": str(app_id)}
    return jwt.encode(payload, private_key, algorithm="RS256")


def token_fingerprint(token: str) -> str:
    """sha256 hex prefix — enough to correlate an issuance to a token in logs/
    receipts WITHOUT storing the token itself."""
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


async def mint_installation_token(
    *,
    app_id: str,
    installation_id: str,
    private_key: str,
    repo: str,
    operation: str,
) -> dict[str, Any]:
    """Mint a GitHub App installation token scoped to a single repo + the minimal
    permission set for ``operation``. Returns ``{token, expires_at}``. GitHub caps
    these at 1h; the caller uses it in-memory then discards it."""
    app_jwt = build_app_jwt(app_id, private_key)
    parts = repo.split("/")
    repo_name = parts[1] if len(parts) == 2 else repo
    body = {"repositories": [repo_name], "permissions": _permissions_for(operation)}
    url = f"{_GITHUB_API_URL}/app/installations/{installation_id}/access_tokens"
    headers = {
        "authorization": f"Bearer {app_jwt}",
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, headers=headers, json=body)
    if resp.status_code >= 300:
        raise RuntimeError(
            f"GitHub installation-token mint failed ({resp.status_code}): {resp.text[:200]}"
        )
    data = resp.json()
    token = data.get("token")
    if not token:
        raise RuntimeError("GitHub installation-token response had no token")
    return {"token": token, "expires_at": data.get("expires_at")}
