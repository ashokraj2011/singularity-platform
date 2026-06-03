"""Capability Governance Model — deterministic overlay resolver (pure).

This module is intentionally DB-free: it operates on plain dicts so it can be
unit-tested without a database. The route layer fetches GovernanceAttachment
rows, maps them to the `attachment` dict shape below, and calls
`resolve_overlay(...)`. Keeping the merge/conflict/hash logic pure is what makes
the "same inputs ⇒ same overlayHash" guarantee testable.

Phase 1 scope: ADVISORY (no enforcement); resolves DIRECT `governed_by`
attachments only (no transitive governance-of-governance — sidesteps cycles).
Conflict order and merge semantics follow the spec (§6.2):

  1. mode rank   BLOCKING > REQUIRED > ADVISORY   (blocking always wins)
  2. scope       STAGE > WORKFLOW > WORKFLOW_TYPE > WORK_ITEM_TYPE > ALL
  3. priority    higher wins
  4. tiebreak    attachment id ascending

Additive sets (evidence, prompt layers, verifiers, blocked tools) are unioned;
tool precedence is blocked > approval_required > allowed.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Optional

MODE_RANK = {"ADVISORY": 1, "REQUIRED": 2, "BLOCKING": 3}
SCOPE_RANK = {"ALL": 0, "WORK_ITEM_TYPE": 1, "WORKFLOW_TYPE": 2, "WORKFLOW": 3, "STAGE": 4}

# scope → which resolution-context key its target_key is matched against.
_SCOPE_CTX_KEY = {
    "WORK_ITEM_TYPE": "workItemType",
    "WORKFLOW_TYPE": "workflowType",
    "WORKFLOW": "workflowId",
}


def _norm_mode(mode: Optional[str]) -> str:
    m = (mode or "ADVISORY").strip().upper()
    return m if m in MODE_RANK else "ADVISORY"


def attachment_applies(att: dict, ctx: dict, now: datetime) -> bool:
    """Whether a single attachment is in-scope + active + within its window."""
    if not att.get("is_active", True):
        return False
    ef, et = att.get("effective_from"), att.get("effective_to")
    if ef is not None and now < ef:
        return False
    if et is not None and now >= et:
        return False
    scope = (att.get("scope") or "ALL").strip().upper()
    if scope == "ALL":
        return True
    if scope == "STAGE":
        # STAGE matches either the loop stage_key or the workflow node id.
        tk = att.get("target_key")
        return tk is not None and tk in (ctx.get("stageKey"), ctx.get("nodeId"))
    ctx_key = _SCOPE_CTX_KEY.get(scope)
    if ctx_key is None:
        return False
    return att.get("target_key") is not None and att.get("target_key") == ctx.get(ctx_key)


def _authority_sort_key(att: dict):
    """Most-authoritative first: mode, then specificity, then priority, then id asc."""
    return (
        -MODE_RANK[_norm_mode(att.get("mode"))],
        -SCOPE_RANK.get((att.get("scope") or "ALL").strip().upper(), 0),
        -int(att.get("priority", 100)),
        str(att.get("id", "")),
    )


def _merge_tool_policy(target: dict, contrib: dict) -> None:
    """blocked > approval_required > allowed. Blocked wins; approval beats allow."""
    for t in contrib.get("blocked", []) or []:
        target["blocked"].add(t)
    for t in contrib.get("approvalRequired", []) or []:
        target["approvalRequired"].add(t)
    for t in contrib.get("allowed", []) or []:
        target["allowed"].add(t)


def _overlay_hash(overlay_core: dict) -> str:
    """sha256 over the canonicalized overlay (excludes overlayId/overlayHash/
    resolvedAt — those are non-deterministic and added by the caller)."""
    canon = json.dumps(overlay_core, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def resolve_overlay(ctx: dict, attachments: list[dict], now: datetime) -> dict:
    """Merge all applicable attachments into a deterministic governance overlay.

    `ctx` keys (all optional except governedCapabilityId): governedCapabilityId,
    workItemType, workflowType, workflowId, stageKey, agentRole, nodeId, riskLevel.
    `attachments`: dicts with id, governing_capability_id, governing_name, mode,
    scope, target_kind, target_key, priority, is_active, effective_from/to,
    waiver_allowed, version, contributions{...}.
    Returns the overlay dict WITHOUT overlayId/resolvedAt (caller stamps those);
    overlayHash IS included and deterministic.
    """
    applicable = [a for a in attachments if attachment_applies(a, ctx, now)]
    applicable.sort(key=_authority_sort_key)

    governing: dict[str, dict] = {}
    prompt_layers: list[dict] = []
    seen_layer: set = set()
    required_evidence: list[dict] = []
    seen_evidence: set = set()
    verifiers: list[dict] = []
    seen_verifier: set = set()
    approval_gates: list[dict] = []
    seen_gate: set = set()
    waiver_rules: list[dict] = []
    seen_waiver: set = set()
    blocking_controls: list[dict] = []
    seen_control: set = set()
    tool = {"blocked": set(), "approvalRequired": set(), "allowed": set()}
    version_pins: dict[str, int] = {}
    effective_rank = 0

    for a in applicable:
        mode = _norm_mode(a.get("mode"))
        effective_rank = max(effective_rank, MODE_RANK[mode])
        gid = a.get("governing_capability_id")
        version_pins[str(a.get("id"))] = int(a.get("version", 1))
        # governing entity (keep the strongest mode seen for this authority)
        ge = governing.get(gid)
        if ge is None or MODE_RANK[mode] > MODE_RANK[ge["mode"]]:
            governing[gid] = {"capabilityId": gid, "name": a.get("governing_name"),
                              "mode": mode, "priority": int(a.get("priority", 100))}
        contrib = a.get("contributions") or {}
        for layer in contrib.get("promptLayers", []) or []:
            key = layer.get("layerKey")
            if key and key not in seen_layer:
                seen_layer.add(key)
                prompt_layers.append({**layer, "sourceCapabilityId": gid})
        for ev in contrib.get("requiredEvidence", []) or []:
            k = (ev.get("evidenceKey"), ev.get("stageKey"))
            if k not in seen_evidence:
                seen_evidence.add(k)
                required_evidence.append({**ev, "mode": ev.get("mode", mode)})
        for vf in contrib.get("verifierAgents", []) or []:
            k = (vf.get("agentTemplateId"), vf.get("trigger"))
            if k not in seen_verifier:
                seen_verifier.add(k)
                verifiers.append({**vf, "sourceCapabilityId": gid})
        for g in contrib.get("approvalGates", []) or []:
            k = (g.get("gateKey"), g.get("stageKey"))
            if k not in seen_gate:
                seen_gate.add(k)
                approval_gates.append(g)
        for w in contrib.get("waiverRules", []) or []:
            if w.get("controlKey") not in seen_waiver:
                seen_waiver.add(w.get("controlKey"))
                waiver_rules.append(w)
        _merge_tool_policy(tool, contrib.get("toolPolicy", {}) or {})
        # Blocking controls only contributed by BLOCKING-mode attachments.
        if mode == "BLOCKING":
            for c in contrib.get("blockingControls", []) or []:
                if c.get("controlKey") not in seen_control:
                    seen_control.add(c.get("controlKey"))
                    blocking_controls.append({**c, "sourceCapabilityId": gid})

    # tool precedence: a blocked tool can't also be approval/allowed; approval beats allow.
    blocked = sorted(tool["blocked"])
    approval = sorted(tool["approvalRequired"] - tool["blocked"])
    allowed = sorted(tool["allowed"] - tool["blocked"] - tool["approvalRequired"])

    effective_mode = next((m for m, r in MODE_RANK.items() if r == effective_rank), "ADVISORY")
    prompt_layers.sort(key=lambda l: (int(l.get("order", 1000)), l.get("layerKey", "")))

    overlay_core = {
        "tenantId": ctx.get("tenantId"),
        "governedCapabilityId": ctx.get("governedCapabilityId"),
        "effectiveMode": effective_mode,
        "governingEntities": sorted(governing.values(), key=lambda g: (-g["priority"], g["capabilityId"])),
        "promptLayers": prompt_layers,
        "requiredEvidence": required_evidence,
        "verifierAgents": verifiers,
        "toolPolicy": {"blocked": blocked, "approvalRequired": approval, "allowed": allowed},
        "approvalGates": approval_gates,
        "waiverRules": waiver_rules,
        "blockingControls": blocking_controls,
        "versionPins": version_pins,
    }
    overlay_core["overlayHash"] = _overlay_hash(overlay_core)
    return overlay_core
