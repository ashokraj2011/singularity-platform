from app.auth.jwt import create_service_token, decode_token


def test_service_token_carries_normalized_tenant_ids():
    token = create_service_token(
        service_name="workgraph-api",
        issued_by_user_id="admin-1",
        scopes=["read:reference-data"],
        tenant_ids=["tenant-b", " tenant-a ", "tenant-a", ""],
        ttl_hours=1,
    )

    payload = decode_token(token)

    assert payload["kind"] == "service"
    assert payload["service_name"] == "workgraph-api"
    assert payload["tenant_ids"] == ["tenant-a", "tenant-b"]
