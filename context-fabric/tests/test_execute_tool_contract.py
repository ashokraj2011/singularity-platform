import inspect
import asyncio

import pytest
from fastapi import HTTPException
from context_api_service.app import execute as execute_module
from context_api_service.app.execute import ExecuteRequest, _normalize_tool_for_mcp


def test_tool_normalization_matches_mcp_schema():
    tool, warnings = _normalize_tool_for_mcp({
        "tool_name": "code.apply_patch",
        "description": "Apply a patch",
        "input_schema": {"type": "object", "required": ["patch"]},
        "execution_target": "remote-service",
        "risk_level": "danger",
        "requires_approval": True,
    })

    assert tool == {
        "name": "code.apply_patch",
        "description": "Apply a patch",
        "input_schema": {"type": "object", "required": ["patch"]},
        "execution_target": "SERVER",
        "requires_approval": True,
        "risk_level": "LOW",
        "capability_id": None,
        "capability_permissions": ["read", "invoke"],
        "read_only": True,
        "provider_locked": False,
        "provider_id": None,
        "provider_manifest_version": None,
        "provider_manifest_digest": None,
        "provider_manifest_signature_key_id": None,
        "provider_manifest_signed": None,
        "source_type": "local",
        "source_ref": None,
        "source": "local",
    }
    assert any("unsupported execution_target" in warning for warning in warnings)
    assert any("unsupported risk_level" in warning for warning in warnings)


def test_tool_normalization_preserves_runtime_capability_metadata():
    tool, warnings = _normalize_tool_for_mcp({
        "tool_name": "github.issue.read",
        "description": "Read GitHub issues",
        "input_schema": {"type": "object", "required": ["owner", "repo"]},
        "providerId": "github",
        "providerManifestVersion": "2026-06-17",
        "providerManifestDigest": "sha256:abc123",
        "providerManifestSignatureKeyId": "github-key-1",
        "providerManifestSigned": True,
        "capabilityId": "github.issue.read",
        "capabilityPermissions": {"read": True, "invoke": True, "edit": False},
        "providerLocked": True,
        "sourceType": "provider_manifest",
        "sourceRef": "https://api.github.test/.well-known/agent-manifest.json",
    })

    assert warnings == []
    assert tool["provider_id"] == "github"
    assert tool["provider_manifest_version"] == "2026-06-17"
    assert tool["provider_manifest_digest"] == "sha256:abc123"
    assert tool["provider_manifest_signature_key_id"] == "github-key-1"
    assert tool["provider_manifest_signed"] is True
    assert tool["capability_id"] == "github.issue.read"
    assert tool["capability_permissions"] == ["read", "invoke"]
    assert tool["read_only"] is True
    assert tool["provider_locked"] is True
    assert tool["source_type"] == "provider_manifest"
    assert tool["source_ref"] == "https://api.github.test/.well-known/agent-manifest.json"
    assert tool["source"] == "provider"


def test_tool_normalization_skips_unnamed_tools():
    tool, warnings = _normalize_tool_for_mcp({"description": "No executable name"})

    assert tool is None
    assert warnings == []


def test_execute_discovers_tools_once_before_prompt_composition():
    source = inspect.getsource(execute_module.execute)
    discovery_start = source.index("tools_for_mcp: list")
    discovery_end = source.index("tools_for_mcp = _merge_mandatory_local_tools", discovery_start)
    discovery_block = source[discovery_start:discovery_end]

    assert '"toolDescriptors": tools_for_mcp' in source
    assert '"tools": tools_for_mcp' in source
    assert '"includeLocalTools": (' in source
    assert 'req.limits.get("include_local_tools", False)' in source
    assert source.index("tools_for_mcp: list") < source.index("compose_payload =")
    assert source.index('"toolDescriptors": tools_for_mcp') < source.index('"tools": tools_for_mcp')
    assert '"effective_capabilities": effective_capabilities' in discovery_block
    assert "timeout=_tool_discovery_timeout_sec()" in discovery_block
    assert "CONTEXT_FABRIC_TOOL_DISCOVERY_TIMEOUT_SEC" in inspect.getsource(execute_module)
    assert "timeout=10.0" not in discovery_block


def test_execute_requires_effective_capabilities_for_profile_backed_tool_filtering():
    source = inspect.getsource(execute_module.execute)

    assert "effective_capabilities_required = bool(req.run_context.agent_template_id or effective_capabilities_provided)" in source
    assert "require_effective_capabilities=effective_capabilities_required" in source
    assert '"effectiveCapabilitiesRequired": effective_capabilities_required' in source


def test_execute_preserves_provider_manifest_resolution_evidence():
    resolver_source = inspect.getsource(execute_module._resolve_agent_profile_capabilities)
    execute_source = inspect.getsource(execute_module.execute)

    assert 'data.get("providerResolutions")' in resolver_source
    assert "profile_provider_resolutions" in execute_source
    assert '"profileProviderResolutions": profile_provider_resolutions' in execute_source
    assert "profile_effective_capabilities" in execute_source


def test_profile_resolution_uses_configured_timeout():
    resolver_source = inspect.getsource(execute_module._resolve_agent_profile_capabilities)
    module_source = inspect.getsource(execute_module)

    assert "_agent_profile_resolve_timeout_sec()" in resolver_source
    assert "CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC" in module_source
    assert "timeout=10.0" not in resolver_source


def test_profile_resolution_passes_timeout_and_service_token(monkeypatch):
    captured: dict = {}

    async def fake_post(url: str, payload: dict, timeout: float = 60.0, headers: dict | None = None) -> dict:
        captured["url"] = url
        captured["payload"] = payload
        captured["timeout"] = timeout
        captured["headers"] = headers
        return {
            "data": {
                "effectiveCapabilities": [{"capabilityId": "github.issue.read"}],
                "snapshotHash": "sha256:profile",
                "providerResolutions": [{"providerId": "github", "manifestVersion": "2026-07-05"}],
            }
        }

    async def fake_token():
        return "service.jwt"

    monkeypatch.setattr(execute_module.settings, "agent_runtime_url", "http://agent-runtime.test")
    monkeypatch.setenv("CONTEXT_FABRIC_AGENT_PROFILE_RESOLVE_TIMEOUT_SEC", "12.5")
    monkeypatch.setattr(execute_module, "_post", fake_post)
    monkeypatch.setattr(execute_module, "get_iam_service_token", fake_token)

    capabilities, snapshot_hash, resolutions = asyncio.run(
        execute_module._resolve_agent_profile_capabilities("agent-profile-1")
    )

    assert capabilities == [{"capabilityId": "github.issue.read"}]
    assert snapshot_hash == "sha256:profile"
    assert resolutions == [{"providerId": "github", "manifestVersion": "2026-07-05"}]
    assert captured == {
        "url": "http://agent-runtime.test/api/v1/agents/profiles/agent-profile-1/resolve",
        "payload": {},
        "timeout": 12.5,
        "headers": {"Authorization": "Bearer service.jwt"},
    }


def test_execute_uses_configured_default_governance_when_omitted():
    execute_source = inspect.getsource(execute_module.execute)

    assert ExecuteRequest(task="inspect").governance_mode is None
    assert "req.governance_mode or settings.default_governance_mode" in execute_source


def test_profile_resolution_fail_closed_uses_normalized_governance_mode():
    execute_source = inspect.getsource(execute_module.execute)
    start = execute_source.index("elif settings.agent_runtime_url and req.run_context.agent_template_id:")
    end = execute_source.index("# Context Fabric owns the run-level tool list.", start)
    profile_resolution_block = execute_source[start:end]

    assert 'if governance_mode == "fail_closed":' in profile_resolution_block
    assert 'if req.governance_mode == "fail_closed":' not in profile_resolution_block


def test_profile_resolution_failure_blocks_when_default_governance_is_fail_closed(monkeypatch):
    async def no_op_precheck(*_args, **_kwargs):
        return None

    async def fail_profile_resolution(*_args, **_kwargs):
        raise RuntimeError("manifest unavailable")

    monkeypatch.setattr(execute_module.settings, "default_governance_mode", "fail_closed")
    monkeypatch.setattr(execute_module.settings, "agent_runtime_url", "http://agent-runtime.test")
    monkeypatch.setattr(execute_module._gov_mod, "fail_closed_precheck", no_op_precheck)
    monkeypatch.setattr(execute_module, "_resolve_agent_profile_capabilities", fail_profile_resolution)

    req = ExecuteRequest(
        task="inspect",
        run_context={
            "capability_id": "cap-critical",
            "agent_template_id": "agent-profile-1",
        },
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(execute_module.execute(req))

    assert exc.value.status_code == 502
    assert "agent profile resolution failed" in str(exc.value.detail)
