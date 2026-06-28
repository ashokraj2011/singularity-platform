"""Unit tests for the governance-overlay audit summary (P1 #19).

The governed.governance_applied event must record WHAT a governance overlay
enforced this turn (blocked/approval tools, required evidence, blocking controls,
prompt layers) — not just its hash — so the audit is complete without re-parsing
the rendered prompt text.
"""
from __future__ import annotations

from context_api_service.app.governed.turn import _summarize_governance_overlay


def test_empty_overlay_degrades_to_empty() -> None:
    s = _summarize_governance_overlay({})
    assert s["overlayHash"] is None
    assert s["effectiveMode"] is None
    assert s["blockedTools"] == []
    assert s["approvalRequiredTools"] == []
    assert s["requiredEvidence"] == []
    assert s["blockingControls"] == []
    assert s["promptLayerKeys"] == []
    assert s["promptLayerCount"] == 0
    assert s["governingEntities"] == []


def test_full_overlay_is_summarized() -> None:
    overlay = {
        "overlayHash": "h1",
        "effectiveMode": "BLOCKING",
        "governingEntities": [{"capabilityId": "cap-gov", "name": "Gov"}],
        "toolPolicy": {"blocked": ["danger_tool"], "approvalRequired": ["deploy"]},
        "requiredEvidence": [{"evidenceKey": "UNIT_TEST"}, {"evidenceKey": "SEC_REVIEW"}],
        "blockingControls": [{"controlKey": "FORMAL"}, "DIFF_VS_DESIGN"],
        "promptLayers": [{"layerKey": "L1", "guidance": "x"}, {"text": "no-key"}],
    }
    s = _summarize_governance_overlay(overlay)
    assert s["overlayHash"] == "h1"
    assert s["effectiveMode"] == "BLOCKING"
    assert s["governingEntities"] == ["cap-gov"]
    assert s["blockedTools"] == ["danger_tool"]
    assert s["approvalRequiredTools"] == ["deploy"]
    assert s["requiredEvidence"] == ["UNIT_TEST", "SEC_REVIEW"]
    assert s["blockingControls"] == ["FORMAL", "DIFF_VS_DESIGN"]  # dict + bare-string forms
    assert s["promptLayerKeys"] == ["L1"]  # only layers with a key
    assert s["promptLayerCount"] == 2  # but the count covers all layers


def test_defensive_on_bad_shapes() -> None:
    # A non-dict toolPolicy / non-list collections must not raise.
    assert _summarize_governance_overlay({"toolPolicy": "nope"})["blockedTools"] == []
    assert _summarize_governance_overlay({"requiredEvidence": None})["requiredEvidence"] == []
    assert _summarize_governance_overlay({"governingEntities": ["not-a-dict"]})["governingEntities"] == []
