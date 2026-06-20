from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text()


def assert_route_uses_dependency(text: str, decorator: str, dependency: str) -> None:
    start = text.index(decorator)
    next_route = text.find("\n@router.", start + len(decorator))
    block = text[start:] if next_route == -1 else text[start:next_route]
    assert f"Depends({dependency})" in block, f"{decorator} must use {dependency}"


def assert_function_uses_dependency(text: str, function_name: str, dependency: str) -> None:
    start = text.index(f"async def {function_name}(")
    next_function = text.find("\nasync def ", start + len(function_name))
    block = text[start:] if next_function == -1 else text[start:next_function]
    assert f"Depends({dependency})" in block, f"{function_name} must use {dependency}"


def test_reference_data_reads_are_scoped_for_service_tokens():
    route_expectations = {
        "app/authz/routes.py": [
            '@router.post("/check", response_model=AuthzCheckResponse)',
            '@router.post("/bulk-check", response_model=BulkCheckResponse)',
        ],
        "app/users/routes.py": [
            '@router.get("", response_model=PageResponse[UserOut])',
            '@router.get("/{user_id}", response_model=UserOut)',
            '@router.get("/{user_id}/roles")',
        ],
        "app/org/routes.py": [
            '@router.get("/business-units", response_model=PageResponse[BusinessUnitOut])',
            '@router.get("/business-units/{bu_id}", response_model=BusinessUnitOut)',
            '@router.get("/business-units/{bu_id}/children", response_model=list[BusinessUnitOut])',
            '@router.get("/teams", response_model=PageResponse[TeamOut])',
            '@router.get("/teams/{team_id}", response_model=TeamOut)',
            '@router.get("/teams/{team_id}/children", response_model=list[TeamOut])',
            '@router.get("/teams/{team_id}/members", response_model=list[TeamMembershipOut])',
            '@router.get("/users/{user_id}/teams", response_model=list[TeamOut])',
            '@router.get("/users/{user_id}/memberships")',
        ],
        "app/roles/routes.py": [
            '@router.get("/permissions", response_model=PageResponse[PermissionOut])',
            '@router.get("/roles", response_model=PageResponse[RoleOut])',
            '@router.get("/roles/{role_key}", response_model=RoleOut)',
            '@router.get("/roles/{role_key}/permissions", response_model=list[PermissionOut])',
        ],
        "app/skills/routes.py": [
            '@router.get("", response_model=SkillPage)',
            '@router.get("/{skill_key}", response_model=SkillOut)',
        ],
        "app/capabilities/routes.py": [
            '@router.get("/capabilities", response_model=PageResponse[CapabilityOut])',
            '@router.get("/capabilities/{capability_id}", response_model=CapabilityOut)',
            '@router.get("/capabilities/{capability_id}/relationships", response_model=list[CapabilityRelationshipOut])',
            '@router.get("/capabilities/{capability_id}/members", response_model=list[CapabilityMembershipOut])',
            '@router.get("/capability-sharing-grants", response_model=PageResponse[SharingGrantOut])',
        ],
        "app/governance/routes.py": [
            '@router.get("/capabilities/{capability_id}/governed-by",\n            response_model=list[GovernanceAttachmentOut])',
            '@router.get("/capabilities/{capability_id}/governs",\n            response_model=list[GovernanceAttachmentOut])',
            '@router.post("/governance/resolve")',
        ],
    }

    for route_file, decorators in route_expectations.items():
        text = source(route_file)
        for decorator in decorators:
            assert_route_uses_dependency(text, decorator, "require_reference_read")


def test_secret_and_audit_reads_use_dedicated_service_scopes():
    mcp = source("app/mcp_servers/routes.py")
    assert_function_uses_dependency(mcp, "list_mcp_servers_for_capability", "require_mcp_server_read")
    assert_function_uses_dependency(mcp, "get_mcp_server", "require_mcp_server_read")

    audit = source("app/audit/routes.py")
    assert_route_uses_dependency(audit, '@router.get("", response_model=PageResponse)', "require_audit_read")


def test_user_only_and_event_subscription_routes_are_not_unscoped():
    main = source("app/main.py")
    assert_route_uses_dependency(main, '@app.get("/api/v1/me", response_model=TokenUserOut)', "require_real_user")

    auth = source("app/auth/routes.py")
    assert_function_uses_dependency(auth, "mint_service_token", "require_super_admin")

    devices = source("app/devices/routes.py")
    for decorator in [
        '@router.post("/auth/device-token", response_model=DeviceTokenResponse, status_code=201)',
        '@router.get("/me/devices", response_model=DeviceList)',
        '@router.delete("/devices/{device_pk}", status_code=200)',
    ]:
        assert_route_uses_dependency(devices, decorator, "require_real_user")

    events = source("app/eventbus/routes.py")
    for decorator in [
        '@router.post("/subscriptions", response_model=SubscriptionOut, status_code=201)',
        '@router.get("/subscriptions")',
        '@router.delete("/subscriptions/{sub_id}", status_code=204)',
        '@router.get("/subscriptions/{sub_id}/deliveries")',
    ]:
        assert_route_uses_dependency(events, decorator, "require_event_publish")


def test_governance_permissions_are_seeded_for_capability_authoring():
    permissions = source("app/seed/default_permissions.py")
    assert '"permission_key": "governance:author"' in permissions
    assert '"permission_key": "governance:enforce"' in permissions

    roles = source("app/seed/default_roles.py")
    platform_admin = roles[roles.index('"role_key": "platform_admin"'):roles.index('"role_key": "platform_auditor"')]
    capability_admin = roles[roles.index('"role_key": "capability_admin"'):roles.index('"role_key": "workflow_designer"')]
    assert '"governance:author"' in platform_admin
    assert '"governance:author"' in capability_admin
    assert '"governance:enforce"' not in platform_admin
    assert '"governance:enforce"' not in capability_admin
