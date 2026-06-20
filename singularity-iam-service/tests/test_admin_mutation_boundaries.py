from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text()


def assert_route_uses_admin_dependency(text: str, decorator: str) -> None:
    start = text.index(decorator)
    next_route = text.find("\n@router.", start + len(decorator))
    block = text[start:] if next_route == -1 else text[start:next_route]
    assert "Depends(require_super_admin)" in block, f"{decorator} must require a real super-admin"


def test_user_and_role_mutations_require_super_admin():
    users = source("app/users/routes.py")
    for decorator in [
        '@router.post("", response_model=UserOut, status_code=201)',
        '@router.patch("/{user_id}", response_model=UserOut)',
        '@router.post("/{user_id}/roles", status_code=201)',
        '@router.delete("/{user_id}/roles/{role_key}", status_code=204)',
    ]:
        assert_route_uses_admin_dependency(users, decorator)

    roles = source("app/roles/routes.py")
    for decorator in [
        '@router.post("/roles", response_model=RoleOut, status_code=201)',
        '@router.post("/roles/{role_key}/permissions", status_code=201)',
        '@router.delete("/roles/{role_key}/permissions/{permission_key}", status_code=204)',
    ]:
        assert_route_uses_admin_dependency(roles, decorator)


def test_org_and_skill_mutations_require_super_admin():
    org = source("app/org/routes.py")
    for decorator in [
        '@router.post("/business-units", response_model=BusinessUnitOut, status_code=201)',
        '@router.patch("/business-units/{bu_id}", response_model=BusinessUnitOut)',
        '@router.post("/business-units/{bu_id}/children", response_model=BusinessUnitOut, status_code=201)',
        '@router.post("/teams", response_model=TeamOut, status_code=201)',
        '@router.patch("/teams/{team_id}", response_model=TeamOut)',
        '@router.post("/teams/{team_id}/children", response_model=TeamOut, status_code=201)',
        '@router.post("/teams/{team_id}/members", response_model=TeamMembershipOut, status_code=201)',
        '@router.delete("/teams/{team_id}/members/{user_id}", status_code=204)',
    ]:
        assert_route_uses_admin_dependency(org, decorator)

    skills = source("app/skills/routes.py")
    assert_route_uses_admin_dependency(skills, '@router.post("", response_model=SkillOut, status_code=201)')


def test_mcp_and_capability_mutations_require_super_admin_but_reference_sync_stays_service_capable():
    mcp = source("app/mcp_servers/routes.py")
    for decorator in [
        '    "/capabilities/{cap_uuid}/mcp-servers",',
        '@router.patch("/mcp-servers/{server_id}", response_model=McpServerOut)',
        '@router.delete("/mcp-servers/{server_id}", status_code=204)',
        '@router.post("/mcp-servers/{server_id}/test", response_model=HealthCheckOut)',
    ]:
        assert_route_uses_admin_dependency(mcp, decorator)

    capabilities = source("app/capabilities/routes.py")
    for decorator in [
        '@router.post("/capabilities", response_model=CapabilityOut, status_code=201)',
        '@router.patch("/capabilities/{capability_id}", response_model=CapabilityOut)',
        '@router.post("/capabilities/{capability_id}/relationships", response_model=CapabilityRelationshipOut, status_code=201)',
        '@router.post("/capabilities/{capability_id}/members", response_model=CapabilityMembershipOut, status_code=201)',
        '@router.post("/capability-sharing-grants", response_model=SharingGrantOut, status_code=201)',
        '@router.post("/capability-sharing-grants/{grant_id}/approve", response_model=SharingGrantOut)',
        '@router.post("/capability-sharing-grants/{grant_id}/revoke", response_model=SharingGrantOut)',
    ]:
        assert_route_uses_admin_dependency(capabilities, decorator)

    reference_start = capabilities.index('@router.put("/capabilities/reference/{capability_id}", response_model=CapabilityOut)')
    reference_end = capabilities.index('@router.get("/capabilities/{capability_id}"', reference_start)
    reference_block = capabilities[reference_start:reference_end]
    assert "Depends(get_current_user)" in reference_block
    assert "Depends(require_super_admin)" not in reference_block
    assert 'assert_super_admin_or_service_scope(current_user, "write:reference-data")' in reference_block
