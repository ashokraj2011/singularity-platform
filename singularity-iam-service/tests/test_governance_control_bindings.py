"""controlBindings resolution (v3) — the governing body owns HOW each control is
evidenced; the overlay carries a map controlKey -> binding consumed by the gate.

Run: PYTHONPATH=singularity-iam-service pytest singularity-iam-service/tests/test_governance_control_bindings.py
"""
from datetime import datetime, timezone

from app.governance.resolver import resolve_overlay

NOW = datetime(2026, 6, 28, tzinfo=timezone.utc)


def _att(**kw):
    base = dict(
        id="a1", governing_capability_id="gov", governing_name="Gov", mode="ADVISORY",
        scope="ALL", target_kind=None, target_key=None, priority=100, is_active=True,
        effective_from=None, effective_to=None, waiver_allowed=False, version=1, contributions={},
    )
    base.update(kw)
    return base


def test_control_bindings_surface_in_overlay():
    o = resolve_overlay({"governedCapabilityId": "cap"}, [_att(contributions={"controlBindings": {
        "SEC_REVIEW": {"type": "evaluator"},
        "REL_NOTES": {"type": "artifact", "artifactName": "release_notes"},
    }})], NOW)
    assert o["controlBindings"]["SEC_REVIEW"]["type"] == "evaluator"
    assert o["controlBindings"]["REL_NOTES"]["artifactName"] == "release_notes"


def test_control_bindings_merge_is_order_independent():
    a1 = _att(id="a1", priority=200, contributions={"controlBindings": {"X": {"type": "evaluator"}}})
    a2 = _att(id="a2", governing_capability_id="g2", priority=100,
              contributions={"controlBindings": {"X": {"type": "artifact"}}})
    o1 = resolve_overlay({"governedCapabilityId": "cap"}, [a1, a2], NOW)
    o2 = resolve_overlay({"governedCapabilityId": "cap"}, [a2, a1], NOW)  # reversed input
    assert o1["controlBindings"]["X"] == o2["controlBindings"]["X"]
    assert o1["overlayHash"] == o2["overlayHash"]


def test_no_control_bindings_yields_empty_map():
    o = resolve_overlay({"governedCapabilityId": "cap"}, [_att()], NOW)
    assert o["controlBindings"] == {}
