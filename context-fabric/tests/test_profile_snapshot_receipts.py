from context_api_service.app import call_log
from context_api_service.app.receipts import _envelope_from_call_log


def test_call_log_persists_compact_profile_effective_capability_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_LOG_DB", str(tmp_path / "call-log.db"))
    monkeypatch.delenv("CALL_LOG_DATABASE_URL", raising=False)
    call_log.refresh_db_target()
    call_log.init_db()

    call_id = call_log.insert({
        "id": "cf-profile-1",
        "trace_id": "trace-profile",
        "capability_id": "cap-app",
        "agent_template_id": "agent-profile-1",
        "profile_snapshot_hash": "sha256:profile",
        "profile_provider_resolutions": [
            {
                "sourceRef": "https://provider.example/manifest.json",
                "status": "resolved",
                "manifestDigest": "sha256:manifest",
                "signatureKeyId": "provider-key-1",
                "signedManifest": True,
            }
        ],
        "profile_effective_capabilities": [
            {
                "id": "github.issue.read",
                "name": "Read issues",
                "sourceType": "provider_manifest",
                "sourceRef": "https://provider.example/manifest.json",
                "skillId": "github",
                "skillName": "GitHub",
                "skillType": "provider",
                "permissions": {"read": True, "invoke": True, "edit": False},
                "readOnly": True,
                "providerLocked": True,
                "providerId": "github",
                "providerManifestVersion": "2026-06-17",
                "providerManifestDigest": "sha256:manifest",
                "providerManifestSignatureKeyId": "provider-key-1",
                "providerManifestSigned": True,
                "schema": {"type": "object"},
                "invocationEndpoint": "https://provider.example/invoke",
            }
        ],
        "status": "COMPLETED",
    })

    row = call_log.get_by_id(call_id)
    assert row is not None
    assert row["profile_snapshot_hash"] == "sha256:profile"
    assert row["profile_provider_resolutions"][0]["manifestDigest"] == "sha256:manifest"
    assert row["profile_effective_capabilities"] == [
        {
            "id": "github.issue.read",
            "name": "Read issues",
            "sourceType": "provider_manifest",
            "sourceRef": "https://provider.example/manifest.json",
            "skillId": "github",
            "skillName": "GitHub",
            "skillType": "provider",
            "permissions": ["invoke", "read"],
            "readOnly": True,
            "providerLocked": True,
            "providerId": "github",
            "providerManifestVersion": "2026-06-17",
            "providerManifestDigest": "sha256:manifest",
            "providerManifestSignatureKeyId": "provider-key-1",
            "providerManifestSigned": True,
        }
    ]
    assert "schema" not in row["profile_effective_capabilities"][0]
    assert "invocationEndpoint" not in row["profile_effective_capabilities"][0]

    receipt = _envelope_from_call_log(row)
    assert receipt["correlation"]["profileSnapshotHash"] == "sha256:profile"
    assert receipt["correlation"]["profileEffectiveCapabilities"] == row["profile_effective_capabilities"]
    assert receipt["payload"]["profile_effective_capability_summary"] == {
        "total": 1,
        "readOnly": 1,
        "invokable": 1,
        "providerLocked": 1,
    }
