"""Tests for governed.grant — the ToolInvocationGrant minter.

The cross-language golden vectors here are mirrored byte-for-byte in
mcp-server/test/tool-grant.test.ts. If you change canonical_json, hash_args,
or the signing-string layout, BOTH suites must be updated together or the live
CF↔MCP grant handshake silently breaks.
"""
from __future__ import annotations

import os

import pytest

from context_api_service.app.governed import grant
from context_api_service.app.governed.phase_state import Phase
from context_api_service.app.governed.policy_loader import PhasePolicy, StagePolicy


# Same secret used by the TS suite's golden signature check.
GOLDEN_SECRET = "test-tool-grant-signing-secret-min-32-chars!!"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Each test owns its own flag/secret state."""
    monkeypatch.delenv("CF_TOOL_GRANT_ENABLED", raising=False)
    monkeypatch.delenv("TOOL_GRANT_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("CF_TOOL_GRANT_TTL_SEC", raising=False)
    yield


def _enable(monkeypatch, secret=GOLDEN_SECRET, ttl=None):
    monkeypatch.setenv("CF_TOOL_GRANT_ENABLED", "true")
    if secret is not None:
        monkeypatch.setenv("TOOL_GRANT_SIGNING_SECRET", secret)
    if ttl is not None:
        monkeypatch.setenv("CF_TOOL_GRANT_TTL_SEC", str(ttl))


def _policy() -> StagePolicy:
    return StagePolicy(
        policy_id="pol-1",
        stage_key="DEVELOP",
        agent_role="DEVELOPER",
        version=3,
        status="ACTIVE",
        approval_model={},
        limits={},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={},
        phases={
            Phase.ACT: PhasePolicy(
                phase=Phase.ACT,
                allowed_tools=frozenset({"apply_patch", "write_file"}),
                forbidden_tools=frozenset({"run_command"}),
                required_output_schema={},
                max_input_tokens=None,
                max_output_tokens=None,
                max_tool_calls=None,
            )
        },
    )


# ── Golden cross-language vectors ────────────────────────────────────────────


def test_canonical_json_golden():
    args = {"b": 1, "a": "x", "nested": {"z": True, "y": [3, 2]}}
    assert grant.canonical_json(args) == '{"a":"x","b":1,"nested":{"y":[3,2],"z":true}}'


def test_hash_args_golden():
    args = {"b": 1, "a": "x", "nested": {"z": True, "y": [3, 2]}}
    assert grant.hash_args(args) == (
        "sha256:ca51e8f4b74028267d5bb1eb1a5ed36d561dc1a844185ef4fd71e7a9284bb301"
    )
    # None and {} hash identically (empty-object canonical form).
    assert grant.hash_args({}) == grant.hash_args(None)
    assert grant.hash_args({}) == (
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    )


def test_sign_grant_golden():
    g = {
        "traceId": "trace-1",
        "stageKey": "DEVELOP",
        "phase": "ACT",
        "toolName": "apply_patch",
        "argsHash": grant.hash_args({}),
        "policyId": "pol-1",
        "policyVersion": 3,
        "policyHash": "sha256:abc",
        "issuedAt": 1000,
        "expiresAt": 1120,
        "nonce": "n1",
    }
    assert grant.sign_grant(g, GOLDEN_SECRET) == (
        "cb69093ae79e1a47b110c0311e0800fbe3d1b7bc949c6608075afc42edd65f75"
    )


def test_policy_hash_is_deterministic_and_content_bound():
    p1 = _policy()
    p2 = _policy()
    assert grant.policy_hash(p1) == grant.policy_hash(p2)
    # Changing the allowlist changes the hash (so a hot policy edit invalidates
    # in-flight grants).
    p3 = _policy()
    p3.phases[Phase.ACT].allowed_tools  # sanity: attribute exists
    p_diff = StagePolicy(
        policy_id="pol-1", stage_key="DEVELOP", agent_role="DEVELOPER", version=3,
        status="ACTIVE", approval_model={}, limits={}, context_policy={},
        edit_policy={}, verification_policy={}, risk_policy={},
        phases={
            Phase.ACT: PhasePolicy(
                phase=Phase.ACT,
                allowed_tools=frozenset({"apply_patch"}),  # dropped write_file
                forbidden_tools=frozenset({"run_command"}),
                required_output_schema={}, max_input_tokens=None,
                max_output_tokens=None, max_tool_calls=None,
            )
        },
    )
    assert grant.policy_hash(p1) != grant.policy_hash(p_diff)


# ── Minting gating (backward compatibility) ──────────────────────────────────


def test_mint_disabled_by_default_returns_none():
    assert grant.mint_tool_grant(
        policy=_policy(), phase=Phase.ACT, tool_name="apply_patch",
        args={"x": 1}, run_context={"traceId": "T"},
    ) is None


def test_mint_enabled_without_secret_returns_none(monkeypatch):
    _enable(monkeypatch, secret=None)
    assert grant.mint_tool_grant(
        policy=_policy(), phase=Phase.ACT, tool_name="apply_patch",
        args={"x": 1}, run_context={"traceId": "T"},
    ) is None


def test_mint_without_policy_or_phase_returns_none(monkeypatch):
    _enable(monkeypatch)
    assert grant.mint_tool_grant(
        policy=None, phase=Phase.ACT, tool_name="apply_patch",
        args={}, run_context={},
    ) is None
    assert grant.mint_tool_grant(
        policy=_policy(), phase=None, tool_name="apply_patch",
        args={}, run_context={},
    ) is None


# ── Mint round-trip ──────────────────────────────────────────────────────────


def test_mint_produces_verifiable_grant(monkeypatch):
    _enable(monkeypatch, ttl=90)
    g = grant.mint_tool_grant(
        policy=_policy(), phase=Phase.ACT, tool_name="apply_patch",
        args={"path": "a.py", "patch": "@@"}, run_context={"traceId": "T-42"},
    )
    assert g is not None
    assert g["v"] == grant.GRANT_VERSION
    assert g["alg"] == grant.GRANT_ALG
    assert g["toolName"] == "apply_patch"
    assert g["stageKey"] == "DEVELOP"
    assert g["phase"] == "ACT"
    assert g["traceId"] == "T-42"
    assert g["policyId"] == "pol-1"
    assert g["policyVersion"] == 3
    assert g["argsHash"] == grant.hash_args({"path": "a.py", "patch": "@@"})
    assert g["policyHash"] == grant.policy_hash(_policy())
    assert g["expiresAt"] - g["issuedAt"] == 90
    # Signature recomputes.
    assert grant.sign_grant(g, GOLDEN_SECRET) == g["sig"]


def test_trace_id_falls_back_through_aliases(monkeypatch):
    _enable(monkeypatch)
    g = grant.mint_tool_grant(
        policy=_policy(), phase=Phase.ACT, tool_name="write_file",
        args={}, run_context={"run_id": "R-9"},
    )
    assert g is not None and g["traceId"] == "R-9"


def test_each_mint_gets_a_fresh_nonce(monkeypatch):
    _enable(monkeypatch)
    nonces = {
        grant.mint_tool_grant(
            policy=_policy(), phase=Phase.ACT, tool_name="apply_patch",
            args={}, run_context={"traceId": "T"},
        )["nonce"]
        for _ in range(50)
    }
    assert len(nonces) == 50  # replay protection relies on uniqueness


def test_ttl_is_clamped(monkeypatch):
    _enable(monkeypatch, ttl=99999)  # above the 3600 ceiling
    g = grant.mint_tool_grant(
        policy=_policy(), phase=Phase.ACT, tool_name="apply_patch",
        args={}, run_context={},
    )
    assert g["expiresAt"] - g["issuedAt"] == 3600
