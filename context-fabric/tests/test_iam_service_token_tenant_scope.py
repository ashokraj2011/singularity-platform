from context_api_service.app import iam_service_token
from context_api_service.app.config import settings


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
