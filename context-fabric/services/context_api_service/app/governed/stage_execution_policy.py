"""
M91.A — StageExecutionPolicy: workflow-owned runtime authority.

Before M91.A, the workflow designer exposed `contextPolicy`,
`toolPolicy`, `repoAccess`, `promptProfileKey` fields per stage (in
NodeInspector.tsx), and the workflow's `vars` dict shipped those
values to Context Fabric — but CF then INDEPENDENTLY resolved the
authoritative StagePolicy from prompt-composer's DB by
(stage_key, agent_role). The designer fields were essentially
decorative: changing `toolPolicy=READ_ONLY` on a stage in the
inspector had no effect on which tools the agent could call at
runtime.

This module fixes the gap. The workflow-resolved policy (built from
`workflow_design_nodes.config` + workflow defaults) ships as a
structured field in the `/execute-governed-stage` request body, and
CF treats it as an OVERRIDE LAYER on top of the prompt-composer
baseline. The DB-seeded policy still provides phase definitions,
budgets, validators, etc. — but the per-phase `allowed_tools` list
is filtered by the StageExecutionPolicy's tool_policy + repo_access.

Layering:

  base StagePolicy (from prompt-composer DB)
    + StageExecutionPolicy (from workflow_design_nodes config)
    = effective StagePolicy CF uses at runtime

When no StageExecutionPolicy is sent (legacy callers, direct API
tests), the base policy is used verbatim — backward-compatible.

The reviewer's design doc framed this as "Workgraph becomes the
owner of workflow/stage intent; Context Fabric becomes the conductor
for context, prompts, phase transitions, and tool exposure." This
module is the seam where those two roles meet.
"""
from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from .policy_loader import PhasePolicy, StagePolicy
from .tool_schemas import categories_for_tool_policy, tool_passes_policy

log = logging.getLogger(__name__)


class StageExecutionPolicy(BaseModel):
    """The workflow designer's stage intent, shipped from Workgraph to CF.

    Each field maps to a column in the workflow_design_nodes.config
    JSON or the loop definition's stage entry. They all default to
    None so a partial policy can be sent (only the fields the workflow
    pinned override the DB seed; the rest fall through).
    """
    model_config = ConfigDict(extra="allow")

    stage_key: str = Field(..., min_length=1)
    agent_role: Optional[str] = None

    # The four operator-visible knobs from NodeInspector.
    # context_policy: STORY_ONLY / REPO_READ_ONLY / CODE_EDIT / VERIFY_ONLY / EVIDENCE_REVIEW / NONE
    context_policy: Optional[str] = None
    # tool_policy: NONE / READ_ONLY / MUTATION / VERIFICATION
    tool_policy: Optional[str] = None
    # repo_access: when False, no tool may touch the workspace even if
    # tool_policy would otherwise allow it. Belt-and-braces with
    # source-materializer's behaviour.
    repo_access: Optional[bool] = None
    # prompt_profile_key: overrides which StagePromptBinding to resolve.
    # When set, CF asks prompt-composer for this profile specifically
    # instead of resolving by (stage_key, agent_role).
    prompt_profile_key: Optional[str] = None

    # approval_required: whether the stage's terminal artifact needs
    # human sign-off. Currently advisory only — workgraph-api owns the
    # gate; this field is for audit trail symmetry.
    approval_required: Optional[bool] = None


# M93.G (2026-05-27) — context_policy → allowed tool categories.
#
# Pre-M93.G the context_policy field on StageExecutionPolicy was audit-
# only: workgraph derived repo_access from it upstream (STORY_ONLY →
# false, etc.) and CF trusted that translation to be exhaustive. That's
# fragile — any caller that sends context_policy without setting
# repo_access correctly gets silently un-enforced. Now context_policy
# is a first-class filter dimension alongside tool_policy.
#
# Each context_policy enum maps to the set of tool categories it
# permits, mirroring how tool_policy works. Mapping rationale:
#   STORY_ONLY      — no code tools at all; only meta tools (verify_meta
#                     + analyzer) for synthetic acknowledgments.
#   REPO_READ_ONLY  — read the repo, no mutation, no execution.
#   CODE_EDIT       — full kit (the development happy path).
#   VERIFY_ONLY     — read + run for executing existing verification
#                     commands; no mutation. QA stages.
#   EVIDENCE_REVIEW — read-only over already-produced evidence; analyzer
#                     for summarising it. SECURITY / DEVOPS review.
#   NONE            — empty (kept for parity with tool_policy=NONE).
_CONTEXT_POLICY_CATEGORIES: dict[str, set[str]] = {
    "STORY_ONLY":      {"verify_meta", "analyzer"},
    "REPO_READ_ONLY":  {"read", "verify_meta", "analyzer"},
    "CODE_EDIT":       {"read", "mutate", "run", "finalize", "verify_meta", "analyzer"},
    "VERIFY_ONLY":     {"read", "run", "verify_meta", "analyzer"},
    "EVIDENCE_REVIEW": {"read", "verify_meta", "analyzer"},
    "NONE":            set(),
}


def _categories_for_context_policy(context_policy: Optional[str]) -> Optional[set[str]]:
    """Resolve the allowed tool-category set for a context_policy enum.

    Returns None when the input doesn't match a known enum — caller
    interprets that as "no filter applied" (no override).
    """
    if not context_policy:
        return None
    key = str(context_policy).strip().upper().replace("-", "_")
    return _CONTEXT_POLICY_CATEGORIES.get(key)


def _filter_phase_tools(
    phase: PhasePolicy,
    tool_policy: Optional[str],
    repo_access: Optional[bool],
    context_policy: Optional[str] = None,
) -> PhasePolicy:
    """Apply a StageExecutionPolicy filter to a single PhasePolicy.

    Returns a new PhasePolicy (PhasePolicy is a dataclass; we use
    dataclasses.replace). The forbidden_tools / required_output_schema
    / *_tokens fields pass through unchanged — only allowed_tools is
    filtered.

    Filter rules (composed in this order; each step NARROWS, never broadens):
      1. If repo_access is explicitly False, strip all repo-touching
         categories (read/mutate/run/finalize). Only verify_meta +
         analyzer survive. This is the most restrictive belt.
      2. If context_policy resolves to a category set (STORY_ONLY,
         REPO_READ_ONLY, CODE_EDIT, VERIFY_ONLY, EVIDENCE_REVIEW, NONE),
         intersect the remaining allowed list with those categories.
         M93.G — pre-M93.G this field was audit-only.
      3. If tool_policy is set, intersect the remaining allowed list
         with the categories that policy permits.

    When all three are None, the input is returned unchanged.

    Composition order matters: repo_access=False is the strongest signal
    (the workspace literally isn't available), context_policy expresses
    the operator's intent for the stage's information surface, and
    tool_policy is the finest-grained explicit pick. Each subsequent
    filter can only narrow what came before — so a CODE_EDIT context
    paired with tool_policy=READ_ONLY ends up as read-only (correct;
    the operator chose to scope tools tighter than the context would
    otherwise allow).
    """
    if repo_access is None and tool_policy is None and context_policy is None:
        return phase

    from .tool_schemas import TOOL_CATEGORY

    allowed = list(phase.allowed_tools)

    # Belt #1: repo_access=False is the hardest constraint.
    if repo_access is False:
        # Strip every repo-touching tool. Leave verify_meta + analyzer
        # so the agent can still emit verification_unavailable / probe
        # stdout. submit_phase_output isn't in allowed_tools (it's a
        # separate meta-tool, always added by the descriptor builder).
        allowed = [
            t for t in allowed
            if TOOL_CATEGORY.get(t, "unknown") in ("verify_meta", "analyzer")
        ]

    # M93.G — context_policy filter. Narrows further when the operator's
    # designer-side intent says so.
    ctx_cats = _categories_for_context_policy(context_policy)
    if ctx_cats is not None:
        allowed = [
            t for t in allowed
            if TOOL_CATEGORY.get(t, "unknown") in ctx_cats
        ]

    # Braces: apply the tool_policy filter to the remaining set.
    if tool_policy is not None:
        cats = categories_for_tool_policy(tool_policy)
        if cats is not None:  # known policy
            allowed = [t for t in allowed if tool_passes_policy(t, tool_policy)]

    return replace(phase, allowed_tools=allowed)


def apply_execution_policy(
    base: StagePolicy,
    override: Optional[StageExecutionPolicy],
) -> StagePolicy:
    """Apply a StageExecutionPolicy override to a base StagePolicy.

    The result is a new StagePolicy with phases[*].allowed_tools
    filtered per the override. All other fields (max_repair_attempts,
    context_policy dict, limits, agent_role, etc.) pass through
    unchanged from the base — those still come from prompt-composer's
    seed. This is intentional: the workflow designer expresses
    high-level intent (which TOOL CLASSES) while the DB seed expresses
    finer-grained shape (which SPECIFIC tools within a class are
    approved for this stage). The override narrows; it never broadens.

    When override is None, the base is returned verbatim.
    """
    if override is None:
        return base
    # M93.G — context_policy joins tool_policy + repo_access as a
    # filter dimension. Skip the rebuild only when ALL three are None.
    if (override.tool_policy is None
        and override.repo_access is None
        and override.context_policy is None):
        return base   # nothing to filter on
    new_phases = {
        phase_enum: _filter_phase_tools(
            phase_policy,
            tool_policy=override.tool_policy,
            repo_access=override.repo_access,
            context_policy=override.context_policy,
        )
        for phase_enum, phase_policy in base.phases.items()
    }
    log.info(
        "stage_exec_policy: applied override stage=%s tool_policy=%s repo_access=%s context_policy=%s",
        base.stage_key, override.tool_policy, override.repo_access, override.context_policy,
    )
    # Diff for audit clarity: how many tools each phase lost.
    for ph, before in base.phases.items():
        after = new_phases[ph]
        dropped = len(before.allowed_tools) - len(after.allowed_tools)
        if dropped > 0:
            log.info(
                "  phase=%s allowed_tools %d → %d (dropped %d)",
                ph.value, len(before.allowed_tools), len(after.allowed_tools), dropped,
            )
    return replace(base, phases=new_phases)


def describe_override_effect(
    base: StagePolicy,
    override: Optional[StageExecutionPolicy],
) -> dict[str, Any]:
    """Build an audit-friendly summary of what the override did.

    Used by the execute endpoint to emit a governed.exec_policy_applied
    event so operators see exactly which tools the workflow's policy
    let through vs which the DB seed had. Returns an empty dict when
    no override was supplied (so callers can spread into payload).
    """
    if override is None:
        return {}
    effective = apply_execution_policy(base, override)
    per_phase: dict[str, Any] = {}
    for ph, before in base.phases.items():
        after = effective.phases[ph]
        per_phase[ph.value] = {
            "before_count": len(before.allowed_tools),
            "after_count": len(after.allowed_tools),
            "dropped": sorted(set(before.allowed_tools) - set(after.allowed_tools)),
        }
    return {
        "tool_policy": override.tool_policy,
        "repo_access": override.repo_access,
        "context_policy": override.context_policy,
        "prompt_profile_key": override.prompt_profile_key,
        "per_phase": per_phase,
    }
