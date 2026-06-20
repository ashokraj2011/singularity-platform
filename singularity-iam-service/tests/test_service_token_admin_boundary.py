import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.auth.deps import (
    assert_real_user_or_service_scope,
    assert_super_admin_or_service_scope,
    is_service_principal,
    require_real_user,
    require_super_admin,
)
from app.auth.jwt import create_service_token
from app.auth.routes import VerifyRequest, _VALID_SCOPES, verify_token


def test_service_principal_detection_uses_service_claim_shape():
    assert is_service_principal(SimpleNamespace(id="service:platform-web")) is True
    assert is_service_principal(SimpleNamespace(id="user-1", service_name="workgraph-api")) is True
    assert is_service_principal(SimpleNamespace(id="user-1", email="user@example.com")) is False


def test_service_token_does_not_inherit_super_admin_dependency():
    principal = SimpleNamespace(
        id="service:platform-web",
        email="platform-web@service.local",
        is_super_admin=True,
        service_name="platform-web",
        scopes=["read:reference-data"],
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(require_super_admin(principal))

    assert exc.value.status_code == 403
    assert "service tokens" in str(exc.value.detail)


def test_service_token_verify_response_is_not_super_admin():
    token = create_service_token(
        service_name="platform-web",
        issued_by_user_id="admin-1",
        scopes=["read:reference-data"],
        ttl_hours=1,
    )

    response = asyncio.run(verify_token(VerifyRequest(token=token), db=None))

    assert response.valid is True
    assert response.user is not None
    assert response.user.id == "service:platform-web"
    assert response.user.is_super_admin is False


def test_service_scope_required_for_reference_writes():
    read_only_service = SimpleNamespace(
        id="service:agent-runtime",
        service_name="agent-runtime",
        is_super_admin=False,
        scopes=["read:reference-data"],
    )
    with pytest.raises(HTTPException) as exc:
        assert_super_admin_or_service_scope(read_only_service, "write:reference-data")
    assert exc.value.status_code == 403

    writable_service = SimpleNamespace(
        id="service:agent-runtime",
        service_name="agent-runtime",
        is_super_admin=False,
        scopes=["read:reference-data", "write:reference-data"],
    )
    assert_super_admin_or_service_scope(writable_service, "write:reference-data")


def test_real_super_admin_still_passes_dependency():
    user = SimpleNamespace(id="user-1", email="admin@example.com", is_super_admin=True)

    assert asyncio.run(require_super_admin(user)) is user
    assert_super_admin_or_service_scope(user, "write:reference-data")


def test_service_read_scope_boundaries_are_enforced():
    mcp_only_service = SimpleNamespace(
        id="service:context-api",
        service_name="context-api",
        is_super_admin=False,
        scopes=["read:mcp-servers"],
    )

    assert_real_user_or_service_scope(mcp_only_service, "read:mcp-servers")
    with pytest.raises(HTTPException) as exc:
        assert_real_user_or_service_scope(mcp_only_service, "read:reference-data")
    assert exc.value.status_code == 403

    real_user = SimpleNamespace(id="user-1", email="user@example.com", is_super_admin=False)
    assert_real_user_or_service_scope(real_user, "read:reference-data")


def test_service_token_cannot_use_user_only_dependency():
    service = SimpleNamespace(id="service:context-api", service_name="context-api", scopes=["read:mcp-servers"])
    with pytest.raises(HTTPException) as exc:
        asyncio.run(require_real_user(service))
    assert exc.value.status_code == 403


def test_iam_mint_allows_distinct_reference_write_scope():
    assert "read:reference-data" in _VALID_SCOPES
    assert "write:reference-data" in _VALID_SCOPES
    assert "governance:author" in _VALID_SCOPES
    assert "governance:enforce" in _VALID_SCOPES
