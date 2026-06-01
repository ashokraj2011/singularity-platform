"""
M71 — Tool gateway unit tests.

Covers the hard-refuse semantics:
  * Empty allowlist → refused.
  * Tool in forbidden_tools → refused even if also in allowed_tools.
  * Tool not in allowed_tools → refused.
  * Tool in allowed_tools (and not forbidden) → allowed.
  * PhaseToolForbidden carries the actual allowlist so the LLM can pick a valid tool.
"""
import pytest

from context_api_service.app.governed.phase_state import Phase
from context_api_service.app.governed.policy_loader import PhasePolicy, StagePolicy
from context_api_service.app.governed.tool_gateway import (
    PhaseToolForbidden,
    allowed_tools_for,
    check_tool_allowed,
)


def _make_policy(
    allowed: list[str],
    forbidden: list[str] | None = None,
    *,
    phase: Phase = Phase.ACT,
) -> StagePolicy:
    """Build a minimal StagePolicy with one phase configured."""
    phase_policy = PhasePolicy(
        phase=phase,
        allowed_tools=frozenset(allowed),
        forbidden_tools=frozenset(forbidden or []),
        required_output_schema={},
        max_input_tokens=None,
        max_output_tokens=None,
        max_tool_calls=None,
    )
    return StagePolicy(
        policy_id="test-policy",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        version=1,
        status="ACTIVE",
        approval_model={},
        limits={"max_repair_attempts": 3},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={},
        phases={phase: phase_policy},
    )


# ── happy path ──────────────────────────────────────────────────────────────


def test_check_allows_tool_in_allowlist():
    policy = _make_policy(["apply_patch", "replace_text"])
    decision = check_tool_allowed(policy, Phase.ACT, "apply_patch")
    assert decision.allowed is True
    assert decision.tool_name == "apply_patch"


def test_allowed_tools_for_returns_sorted_diff():
    policy = _make_policy(["replace_text", "apply_patch", "write_file"], forbidden=["write_file"])
    tools = allowed_tools_for(policy, Phase.ACT)
    # write_file removed (in deny); rest sorted alphabetically.
    assert tools == ("apply_patch", "replace_text")


# ── hard refuse cases ───────────────────────────────────────────────────────


def test_refuses_tool_not_in_allowlist_raises():
    """The default behaviour: raise PhaseToolForbidden so the loop returns
    a 400 with the actual allowlist."""
    policy = _make_policy(["apply_patch"])
    with pytest.raises(PhaseToolForbidden) as exc_info:
        check_tool_allowed(policy, Phase.ACT, "shell_unrestricted")
    assert exc_info.value.tool_name == "shell_unrestricted"
    assert exc_info.value.phase is Phase.ACT
    assert exc_info.value.allowed_tools == ("apply_patch",)
    assert "not in the allowlist" in exc_info.value.reason


def test_refuses_tool_when_explicitly_forbidden():
    """If a tool appears in BOTH allowed AND forbidden, deny wins (spec §8)."""
    policy = _make_policy(["apply_patch", "write_file"], forbidden=["write_file"])
    with pytest.raises(PhaseToolForbidden) as exc_info:
        check_tool_allowed(policy, Phase.ACT, "write_file")
    assert "explicitly forbidden" in exc_info.value.reason
    assert "write_file" not in exc_info.value.allowed_tools


def test_refuses_when_phase_has_no_policy_row():
    """If the policy doesn't have a row for this phase, no tool is allowed."""
    policy = _make_policy(["apply_patch"], phase=Phase.ACT)
    # Try to call a tool while supposedly in REPAIR — there's no REPAIR row.
    with pytest.raises(PhaseToolForbidden) as exc_info:
        check_tool_allowed(policy, Phase.REPAIR, "apply_patch")
    assert exc_info.value.allowed_tools == ()


def test_refuse_returns_decision_when_raise_disabled():
    """raise_on_refuse=False is the bulk-check mode for the loop."""
    policy = _make_policy(["apply_patch"])
    decision = check_tool_allowed(policy, Phase.ACT, "deploy", raise_on_refuse=False)
    assert decision.allowed is False
    assert "deploy" in decision.reason


# ── error structure ────────────────────────────────────────────────────────


def test_phase_tool_forbidden_to_dict_shape():
    """The wire shape returned in the /execute response must include the
    allowlist so the LLM can self-correct without guessing."""
    exc = PhaseToolForbidden(
        tool_name="apply_patch",
        phase=Phase.PLAN,
        allowed_tools=("repo_map", "find_symbol"),
        reason="tool 'apply_patch' is not in the allowlist for phase PLAN",
    )
    body = exc.to_dict()
    assert body["error_code"] == "PHASE_TOOL_FORBIDDEN"
    assert body["tool_name"] == "apply_patch"
    assert body["phase"] == "PLAN"
    assert body["allowed_tools"] == ["repo_map", "find_symbol"]
    assert "allowlist" in body["reason"]
