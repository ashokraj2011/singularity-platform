from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text()


def test_authz_contract_requires_tenant_and_binds_human_subjects():
    schemas = source("app/authz/schemas.py")
    routes = source("app/authz/routes.py")
    resolver = source("app/authz/resolver.py")

    assert "tenant_id: str" in schemas
    assert "require_authz_check" in routes
    assert "User tokens may only check their own authorization" in routes
    assert "Service token is not scoped for this tenant" in routes
    assert "UserTenantMembership" in resolver
    assert "User is not an active member of this tenant" in resolver
    assert "tenant_id: str" in resolver
    assert "Team.tenant_id == tenant_id" in resolver
    assert "CapabilityMembership.valid_until" in resolver
    assert "policy_version" in routes
    assert "decision_id" in routes


def test_authz_service_scope_is_explicit():
    routes = source("app/auth/routes.py")
    deps = source("app/auth/deps.py")
    assert '"authz:check"' in routes
    assert '"authz:check"' in deps
