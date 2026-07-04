import asyncio

import pytest

from app.auth import sso


def test_sso_readiness_reports_local_mode(monkeypatch):
    monkeypatch.setattr(sso.settings, "IAM_AUTH_MODE", "local")

    readiness = sso.sso_readiness()

    assert readiness["mode"] == "local"
    assert readiness["localLoginEnabled"] is True
    assert readiness["oidc"]["enabled"] is False


def test_sso_readiness_reports_oidc_metadata(monkeypatch):
    monkeypatch.setattr(sso.settings, "IAM_AUTH_MODE", "oidc")
    monkeypatch.setattr(sso.settings, "OIDC_ISSUER_URL", "https://idp.example.com/oauth2/default")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_ID", "singularity")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_SECRET", "strong-oidc-secret")
    monkeypatch.setattr(sso.settings, "OIDC_REDIRECT_URI", "https://platform.example.com/identity/oidc/callback")
    monkeypatch.setattr(sso.settings, "OIDC_ALLOWED_DOMAINS", "example.com, engineering.example.com")
    monkeypatch.setattr(sso.settings, "OIDC_ADMIN_EMAILS", "admin@example.com")

    readiness = sso.sso_readiness()

    assert readiness["mode"] == "oidc"
    assert readiness["localLoginEnabled"] is False
    assert readiness["oidc"]["configured"] is True
    assert readiness["oidc"]["authorizationEndpoint"] == "https://idp.example.com/oauth2/default/authorize"
    assert readiness["oidc"]["tokenEndpoint"] == "https://idp.example.com/oauth2/default/token"
    assert readiness["oidc"]["jwksUri"] == "https://idp.example.com/oauth2/default/.well-known/jwks.json"
    assert readiness["oidc"]["allowedDomains"] == ["engineering.example.com", "example.com"]
    assert readiness["oidc"]["adminEmails"] == ["admin@example.com"]


def test_oidc_authorization_url_contains_required_params(monkeypatch):
    monkeypatch.setattr(sso.settings, "OIDC_ISSUER_URL", "https://idp.example.com")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_ID", "singularity")
    monkeypatch.setattr(sso.settings, "OIDC_REDIRECT_URI", "https://platform.example.com/callback")
    monkeypatch.setattr(sso.settings, "OIDC_SCOPES", "openid email profile")

    url = sso.oidc_authorization_url("state-1", "nonce-1")

    assert url.startswith("https://idp.example.com/authorize?")
    assert "response_type=code" in url
    assert "client_id=singularity" in url
    assert "redirect_uri=https%3A%2F%2Fplatform.example.com%2Fcallback" in url
    assert "scope=openid+email+profile" in url
    assert "state=state-1" in url
    assert "nonce=nonce-1" in url


def test_federated_identity_maps_claims_and_admin(monkeypatch):
    monkeypatch.setattr(sso.settings, "OIDC_ISSUER_URL", "https://idp.example.com")
    monkeypatch.setattr(sso.settings, "OIDC_SUBJECT_CLAIM", "sub")
    monkeypatch.setattr(sso.settings, "OIDC_EMAIL_CLAIM", "email")
    monkeypatch.setattr(sso.settings, "OIDC_NAME_CLAIM", "name")
    monkeypatch.setattr(sso.settings, "OIDC_ALLOWED_DOMAINS", "example.com")
    monkeypatch.setattr(sso.settings, "OIDC_ADMIN_EMAILS", "Admin@Example.com, admin@example.com")

    identity = sso.federated_identity_from_claims({
        "sub": "idp-user-1",
        "email": "Admin@Example.com",
        "name": "Admin User",
        "email_verified": True,
    })

    assert identity["provider"] == "oidc"
    assert identity["subject"] == "idp-user-1"
    assert identity["email"] == "admin@example.com"
    assert identity["display_name"] == "Admin User"
    assert identity["is_super_admin"] is True
    assert identity["metadata"]["issuer"] == "https://idp.example.com"
    assert identity["metadata"]["email_verified"] is True


def test_federated_identity_rejects_disallowed_domain(monkeypatch):
    monkeypatch.setattr(sso.settings, "OIDC_SUBJECT_CLAIM", "sub")
    monkeypatch.setattr(sso.settings, "OIDC_EMAIL_CLAIM", "email")
    monkeypatch.setattr(sso.settings, "OIDC_ALLOWED_DOMAINS", "example.com")

    try:
        sso.federated_identity_from_claims({"sub": "idp-user-1", "email": "user@other.example"})
    except ValueError as exc:
        assert "domain" in str(exc)
    else:
        raise AssertionError("expected disallowed domain to fail")


def test_oidc_nonce_mismatch_fails_closed():
    try:
        sso.assert_oidc_nonce({"nonce": "actual"}, "expected")
    except ValueError as exc:
        assert "nonce" in str(exc)
    else:
        raise AssertionError("expected nonce mismatch to fail")


def test_oidc_nonce_match_passes():
    sso.assert_oidc_nonce({"nonce": "expected"}, "expected")
    sso.assert_oidc_nonce({"nonce": "provider-without-nonce"}, None)


def test_exchange_oidc_authorization_code_posts_to_token_endpoint(monkeypatch):
    calls = []

    monkeypatch.setattr(sso.settings, "OIDC_ISSUER_URL", "https://idp.example.com/oauth2/default")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_ID", "singularity")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(sso.settings, "OIDC_REDIRECT_URI", "https://platform.example.com/identity/oidc/callback")

    class FakeResponse:
        status_code = 200
        text = '{"id_token": "header.payload.signature"}'

        def json(self):
            return {"id_token": "header.payload.signature"}

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, data, headers):
            calls.append({"url": url, "data": data, "headers": headers})
            return FakeResponse()

    monkeypatch.setattr(sso.httpx, "AsyncClient", FakeAsyncClient)

    id_token = asyncio.run(sso.exchange_oidc_authorization_code("auth-code"))

    assert id_token == "header.payload.signature"
    assert calls == [{
        "url": "https://idp.example.com/oauth2/default/token",
        "data": {
            "grant_type": "authorization_code",
            "code": "auth-code",
            "redirect_uri": "https://platform.example.com/identity/oidc/callback",
            "client_id": "singularity",
            "client_secret": "client-secret",
        },
        "headers": {"accept": "application/json"},
    }]


def test_exchange_oidc_authorization_code_rejects_invalid_json(monkeypatch):
    monkeypatch.setattr(sso.settings, "OIDC_ISSUER_URL", "https://idp.example.com")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_ID", "singularity")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(sso.settings, "OIDC_REDIRECT_URI", "https://platform.example.com/callback")

    class FakeResponse:
        status_code = 200
        text = "Internal Server Error"

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, data, headers):
            return FakeResponse()

    monkeypatch.setattr(sso.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match=r"OIDC token endpoint returned invalid JSON .*Internal Server Error"):
        asyncio.run(sso.exchange_oidc_authorization_code("auth-code"))


def test_exchange_oidc_authorization_code_reports_provider_error(monkeypatch):
    monkeypatch.setattr(sso.settings, "OIDC_ISSUER_URL", "https://idp.example.com")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_ID", "singularity")
    monkeypatch.setattr(sso.settings, "OIDC_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(sso.settings, "OIDC_REDIRECT_URI", "https://platform.example.com/callback")

    class FakeResponse:
        status_code = 400
        text = '{"error_description": "authorization code expired"}'

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, data, headers):
            return FakeResponse()

    monkeypatch.setattr(sso.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match=r"OIDC token exchange failed \(400\): authorization code expired"):
        asyncio.run(sso.exchange_oidc_authorization_code("auth-code"))
