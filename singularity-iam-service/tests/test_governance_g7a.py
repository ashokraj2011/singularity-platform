"""G7a — governance mutate-endpoint helpers + resolver hardening (pure tests).

Covers the DB-free units: authority gate, contributions validation, and the
resolver's per-evidence mode stamping (the "no mode bleed" regression).
"""
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.governance.authz import assert_governance_authority, validate_contributions
from app.governance.resolver import resolve_overlay

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _user(*, super_admin=False, scopes=None):
    ns = SimpleNamespace(id="11111111-1111-1111-1111-111111111111", is_super_admin=super_admin)
    if scopes is not None:
        ns.scopes = scopes
    return ns


def _service(*, scopes=None):
    # _ServicePrincipal carries .service_name and blanket is_super_admin=True (M11).
    return SimpleNamespace(id="service:reconciler", service_name="reconciler",
                           is_super_admin=True, scopes=scopes or [])


# ── authority gate ────────────────────────────────────────────────────────

def test_advisory_authoring_allows_any_real_user():
    assert_governance_authority(_user(), enforcing=False)  # no raise


def test_enforcing_requires_elevated_authority_for_real_user():
    with pytest.raises(HTTPException) as ei:
        assert_governance_authority(_user(super_admin=False), enforcing=True)
    assert ei.value.status_code == 403


def test_enforcing_allowed_for_super_admin():
    assert_governance_authority(_user(super_admin=True), enforcing=True)


def test_enforcing_allowed_for_real_user_with_enforce_scope():
    assert_governance_authority(_user(scopes=["governance:enforce"]), enforcing=True)


def test_service_principal_needs_author_scope_even_for_advisory():
    with pytest.raises(HTTPException) as ei:
        assert_governance_authority(_service(scopes=[]), enforcing=False)
    assert ei.value.status_code == 403
    assert_governance_authority(_service(scopes=["governance:author"]), enforcing=False)


def test_service_blanket_super_admin_cannot_enforce():
    # author scope is NOT enough to enforce, and blanket is_super_admin must not bypass.
    with pytest.raises(HTTPException) as ei:
        assert_governance_authority(_service(scopes=["governance:author"]), enforcing=True)
    assert ei.value.status_code == 403


def test_service_with_enforce_scope_can_enforce():
    assert_governance_authority(_service(scopes=["governance:enforce"]), enforcing=True)


# ── contributions validation ────────────────────────────────────────────────

def test_validate_contributions_accepts_none_and_empty():
    validate_contributions(None, "ADVISORY")
    validate_contributions({}, "ADVISORY")


def test_validate_contributions_accepts_well_formed():
    validate_contributions({
        "promptLayers": [{"layerKey": "x", "order": 1, "text": "t"}],
        "requiredEvidence": [{"evidenceKey": "unit_tests", "stageKey": "DEVELOP", "mode": "BLOCKING"}],
        "blockingControls": [{"controlKey": "scan_clean"}],
        "toolPolicy": {"blocked": ["rm"], "approvalRequired": [], "allowed": []},
    }, "BLOCKING")


@pytest.mark.parametrize("bad", [
    {"blockingControls": [{}]},                                   # missing controlKey
    {"requiredEvidence": [{"stageKey": "DEVELOP"}]},              # missing evidenceKey
    {"requiredEvidence": [{"evidenceKey": "x", "mode": "NOPE"}]}, # bad mode
    {"toolPolicy": {"blocked": [1, 2]}},                          # non-string tools
    {"requiredEvidence": "not-a-list"},                          # wrong type
    {"approvalGates": [{"stageKey": "X"}]},                      # missing gateKey
])
def test_validate_contributions_rejects_malformed(bad):
    with pytest.raises(HTTPException) as ei:
        validate_contributions(bad, "BLOCKING")
    assert ei.value.status_code == 422


# ── resolver hardening: per-evidence mode stamping (no bleed) ────────────────

def _att(id_, gid, mode, contributions):
    return {"id": id_, "governing_capability_id": gid, "governing_name": gid, "mode": mode,
            "scope": "ALL", "target_kind": None, "target_key": None, "priority": 100,
            "is_active": True, "effective_from": None, "effective_to": None,
            "waiver_allowed": False, "version": 1, "contributions": contributions}


def test_evidence_keeps_its_source_attachment_mode():
    adv = _att("a1", "gA", "ADVISORY", {"requiredEvidence": [{"evidenceKey": "adv_only"}]})
    blk = _att("b1", "gB", "BLOCKING", {"requiredEvidence": [{"evidenceKey": "blk_only"}],
                                        "blockingControls": [{"controlKey": "must_pass"}]})
    ov = resolve_overlay({"governedCapabilityId": "cap"}, [adv, blk], NOW)
    by_key = {e["evidenceKey"]: e for e in ov["requiredEvidence"]}
    # A BLOCKING sibling must not turn the ADVISORY attachment's mode-less evidence blocking.
    assert by_key["adv_only"]["mode"] == "ADVISORY"
    assert by_key["blk_only"]["mode"] == "BLOCKING"
    assert ov["effectiveMode"] == "BLOCKING"
    assert [c["controlKey"] for c in ov["blockingControls"]] == ["must_pass"]


def test_blocking_controls_only_contributed_by_blocking_mode():
    req = _att("r1", "gR", "REQUIRED", {"blockingControls": [{"controlKey": "x"}]})
    ov = resolve_overlay({"governedCapabilityId": "cap"}, [req], NOW)
    assert ov["blockingControls"] == []  # REQUIRED (not BLOCKING) contributes no blocking controls
    assert ov["effectiveMode"] == "REQUIRED"
