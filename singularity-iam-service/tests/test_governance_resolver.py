"""Pure-function tests for the governance overlay resolver (no DB).

Run: PYTHONPATH=singularity-iam-service pytest singularity-iam-service/tests/test_governance_resolver.py
"""
from datetime import datetime, timezone, timedelta

from app.governance.resolver import resolve_overlay, attachment_applies

NOW = datetime(2026, 6, 3, tzinfo=timezone.utc)


def _att(**kw):
    base = dict(
        id="a1", governing_capability_id="gov", governing_name="Gov",
        mode="ADVISORY", scope="ALL", target_kind=None, target_key=None,
        priority=100, is_active=True, effective_from=None, effective_to=None,
        waiver_allowed=False, version=1, contributions={},
    )
    base.update(kw)
    return base


def test_scope_matching():
    ctx = {"governedCapabilityId": "cap", "stageKey": "DEVELOP", "nodeId": "node_dev",
           "workItemType": "BUG_FIX", "workflowId": "wf1", "workflowType": "SD"}
    assert attachment_applies(_att(scope="ALL"), ctx, NOW)
    assert attachment_applies(_att(scope="STAGE", target_key="DEVELOP"), ctx, NOW)
    assert attachment_applies(_att(scope="STAGE", target_key="node_dev"), ctx, NOW)
    assert not attachment_applies(_att(scope="STAGE", target_key="QA"), ctx, NOW)
    assert attachment_applies(_att(scope="WORK_ITEM_TYPE", target_key="BUG_FIX"), ctx, NOW)
    assert not attachment_applies(_att(scope="WORK_ITEM_TYPE", target_key="FEATURE"), ctx, NOW)
    assert attachment_applies(_att(scope="WORKFLOW", target_key="wf1"), ctx, NOW)
    assert attachment_applies(_att(scope="WORKFLOW_TYPE", target_key="SD"), ctx, NOW)


def test_inactive_and_effective_window():
    ctx = {"governedCapabilityId": "cap"}
    assert not attachment_applies(_att(is_active=False), ctx, NOW)
    assert not attachment_applies(_att(effective_from=NOW + timedelta(days=1)), ctx, NOW)
    assert not attachment_applies(_att(effective_to=NOW - timedelta(days=1)), ctx, NOW)
    assert attachment_applies(
        _att(effective_from=NOW - timedelta(days=1), effective_to=NOW + timedelta(days=1)), ctx, NOW)


def test_deterministic_hash_is_order_independent():
    ctx = {"governedCapabilityId": "cap", "stageKey": "DEVELOP"}
    a = _att(id="a1", contributions={"promptLayers": [{"layerKey": "SEC", "order": 40}]})
    b = _att(id="a2", governing_capability_id="g2",
             contributions={"promptLayers": [{"layerKey": "ARCH", "order": 30}]})
    h1 = resolve_overlay(ctx, [a, b], NOW)["overlayHash"]
    h2 = resolve_overlay(ctx, [b, a], NOW)["overlayHash"]  # reversed input
    assert h1 == h2 and h1.startswith("sha256:")


def test_effective_mode_and_blocking_controls():
    ctx = {"governedCapabilityId": "cap"}
    atts = [
        _att(id="a1", mode="ADVISORY"),
        _att(id="a2", governing_capability_id="g2", mode="BLOCKING",
             contributions={"blockingControls": [{"controlKey": "SEC_REVIEW", "reason": "x"}]}),
    ]
    o = resolve_overlay(ctx, atts, NOW)
    assert o["effectiveMode"] == "BLOCKING"
    assert [c["controlKey"] for c in o["blockingControls"]] == ["SEC_REVIEW"]


def test_advisory_never_contributes_blocking_controls():
    ctx = {"governedCapabilityId": "cap"}
    atts = [_att(mode="ADVISORY", contributions={"blockingControls": [{"controlKey": "X", "reason": "y"}]})]
    o = resolve_overlay(ctx, atts, NOW)
    assert o["blockingControls"] == []
    assert o["effectiveMode"] == "ADVISORY"


def test_tool_policy_precedence_block_over_approval_over_allow():
    ctx = {"governedCapabilityId": "cap"}
    atts = [
        _att(id="a1", contributions={"toolPolicy": {"allowed": ["x", "gitpush"], "approvalRequired": ["gitpush"]}}),
        _att(id="a2", governing_capability_id="g2", contributions={"toolPolicy": {"blocked": ["gitpush", "netcall"]}}),
    ]
    tp = resolve_overlay(ctx, atts, NOW)["toolPolicy"]
    assert "gitpush" in tp["blocked"]
    assert "gitpush" not in tp["approvalRequired"] and "gitpush" not in tp["allowed"]
    assert "x" in tp["allowed"] and "netcall" in tp["blocked"]


def test_prompt_layers_dedup_and_order():
    ctx = {"governedCapabilityId": "cap"}
    atts = [
        _att(id="a1", contributions={"promptLayers": [{"layerKey": "SEC", "order": 40}]}),
        _att(id="a2", governing_capability_id="g2",
             contributions={"promptLayers": [{"layerKey": "ARCH", "order": 30}, {"layerKey": "SEC", "order": 40}]}),
    ]
    keys = [l["layerKey"] for l in resolve_overlay(ctx, atts, NOW)["promptLayers"]]
    assert keys == ["ARCH", "SEC"]  # deduped + ordered by `order`


def test_verifier_dedup_by_template_and_trigger():
    ctx = {"governedCapabilityId": "cap"}
    atts = [
        _att(id="a1", contributions={"verifierAgents": [{"agentTemplateId": "v", "trigger": "BEFORE_STAGE_APPROVAL"}]}),
        _att(id="a2", governing_capability_id="g2",
             contributions={"verifierAgents": [{"agentTemplateId": "v", "trigger": "BEFORE_STAGE_APPROVAL"}]}),
    ]
    assert len(resolve_overlay(ctx, atts, NOW)["verifierAgents"]) == 1


def test_out_of_scope_attachments_excluded_from_overlay():
    ctx = {"governedCapabilityId": "cap", "stageKey": "DEVELOP"}
    atts = [_att(id="a1", scope="STAGE", target_key="QA",
                 contributions={"promptLayers": [{"layerKey": "QA_ONLY", "order": 10}]})]
    o = resolve_overlay(ctx, atts, NOW)
    assert o["promptLayers"] == [] and o["governingEntities"] == []
