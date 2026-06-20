from __future__ import annotations

from urllib.parse import urlencode

import httpx
import jwt

from app.config import settings


def _csv(raw: str) -> list[str]:
    return sorted({part.strip() for part in raw.split(",") if part.strip()})


def auth_mode() -> str:
    return settings.IAM_AUTH_MODE.strip().lower()


def oidc_configured() -> bool:
    return all(
        (getattr(settings, name) or "").strip()
        for name in ("OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI")
    )


def oidc_authorization_endpoint() -> str:
    issuer = (settings.OIDC_ISSUER_URL or "").rstrip("/")
    return f"{issuer}/authorize"


def oidc_token_endpoint() -> str:
    issuer = (settings.OIDC_ISSUER_URL or "").rstrip("/")
    return f"{issuer}/token"


def oidc_jwks_uri() -> str:
    issuer = (settings.OIDC_ISSUER_URL or "").rstrip("/")
    return f"{issuer}/.well-known/jwks.json"


def oidc_authorization_url(state: str, nonce: str) -> str:
    query = urlencode({
        "response_type": "code",
        "client_id": settings.OIDC_CLIENT_ID or "",
        "redirect_uri": settings.OIDC_REDIRECT_URI or "",
        "scope": settings.OIDC_SCOPES,
        "state": state,
        "nonce": nonce,
    })
    return f"{oidc_authorization_endpoint()}?{query}"


async def exchange_oidc_authorization_code(code: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                oidc_token_endpoint(),
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": settings.OIDC_REDIRECT_URI or "",
                    "client_id": settings.OIDC_CLIENT_ID or "",
                    "client_secret": settings.OIDC_CLIENT_SECRET or "",
                },
                headers={"accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise ValueError(f"OIDC token exchange failed: {exc}") from exc

    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            body = response.text
        raise ValueError(f"OIDC token exchange failed: {body}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise ValueError("OIDC token endpoint returned invalid JSON") from exc

    id_token = payload.get("id_token")
    if not isinstance(id_token, str) or not id_token.strip():
        raise ValueError("OIDC token endpoint did not return an id_token")
    return id_token


def assert_oidc_nonce(claims: dict, expected_nonce: str | None) -> None:
    if expected_nonce and claims.get("nonce") != expected_nonce:
        raise ValueError("OIDC id_token nonce does not match the browser login request")


def verify_oidc_id_token(id_token: str, expected_nonce: str | None = None) -> dict:
    try:
        jwks_client = jwt.PyJWKClient(oidc_jwks_uri())
        signing_key = jwks_client.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience=settings.OIDC_CLIENT_ID,
            issuer=settings.OIDC_ISSUER_URL,
        )
        assert_oidc_nonce(claims, expected_nonce)
        return claims
    except jwt.PyJWTError as exc:
        raise ValueError(f"Invalid OIDC id_token: {exc}") from exc


def federated_identity_from_claims(claims: dict) -> dict:
    subject = str(claims.get(settings.OIDC_SUBJECT_CLAIM) or "").strip()
    email = str(claims.get(settings.OIDC_EMAIL_CLAIM) or "").strip().lower()
    display_name = str(claims.get(settings.OIDC_NAME_CLAIM) or email).strip() or email
    if not subject:
        raise ValueError(f"OIDC token is missing subject claim {settings.OIDC_SUBJECT_CLAIM!r}")
    if not email or "@" not in email:
        raise ValueError(f"OIDC token is missing email claim {settings.OIDC_EMAIL_CLAIM!r}")

    allowed_domains = _csv(settings.OIDC_ALLOWED_DOMAINS)
    domain = email.rsplit("@", 1)[1]
    if allowed_domains and domain not in allowed_domains:
        raise ValueError("OIDC email domain is not allowed")

    return {
        "provider": "oidc",
        "subject": subject,
        "email": email,
        "display_name": display_name,
        "is_super_admin": email in _csv(settings.OIDC_ADMIN_EMAILS),
        "metadata": {
            "issuer": settings.OIDC_ISSUER_URL,
            "email_verified": bool(claims.get("email_verified", False)),
        },
    }


def sso_readiness() -> dict:
    mode = auth_mode()
    oidc_ready = oidc_configured()
    return {
        "mode": mode,
        "localLoginEnabled": mode == "local",
        "oidc": {
            "enabled": mode == "oidc",
            "configured": oidc_ready,
            "issuerUrl": settings.OIDC_ISSUER_URL if mode == "oidc" else None,
            "clientIdConfigured": bool((settings.OIDC_CLIENT_ID or "").strip()),
            "clientSecretConfigured": bool((settings.OIDC_CLIENT_SECRET or "").strip()),
            "redirectUri": settings.OIDC_REDIRECT_URI if mode == "oidc" else None,
            "scopes": settings.OIDC_SCOPES.split(),
            "allowedDomains": _csv(settings.OIDC_ALLOWED_DOMAINS),
            "adminEmails": _csv(settings.OIDC_ADMIN_EMAILS),
            "authorizationEndpoint": oidc_authorization_endpoint() if oidc_ready else None,
            "tokenEndpoint": oidc_token_endpoint() if oidc_ready else None,
            "jwksUri": oidc_jwks_uri() if oidc_ready else None,
        },
    }
