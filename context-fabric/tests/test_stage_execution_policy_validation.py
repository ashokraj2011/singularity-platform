"""
Review #5 — StageExecutionPolicy fail-closed validation.

Before: an INVALID tool_policy / context_policy resolved to None inside the
filter, so NO filter was applied and the more-permissive DB-seeded base policy
ran verbatim — a malformed policy silently failed OPEN. apply_execution_policy
now rejects unknown enum values with StageExecutionPolicyError. Known values
(any case) and partial/None policies still work; camelCase M99 aliases still
populate.
"""
import pytest

from context_api_service.app.governed.phase_state import Phase
from context_api_service.app.governed.policy_loader import PhasePolicy, StagePolicy
from context_api_service.app.governed.stage_execution_policy import (
    StageExecutionPolicy,
    StageExecutionPolicyError,
    apply_execution_policy,
)


def _base(allowed: list[str]) -> StagePolicy:
    pp = PhasePolicy(
        phase=Phase.ACT,
        allowed_tools=frozenset(allowed),
        forbidden_tools=frozenset(),
        required_output_schema={},
        max_input_tokens=None,
        max_output_tokens=None,
        max_tool_calls=None,
    )
    return StagePolicy(
        policy_id="p", stage_key="loop.stage", agent_role="DEVELOPER", version=1,
        status="ACTIVE", approval_model={}, limits={}, context_policy={},
        edit_policy={}, verification_policy={}, risk_policy={},
        phases={Phase.ACT: pp},
    )


def test_unknown_tool_policy_is_rejected():
    base = _base(["read_file", "apply_patch"])
    bad = StageExecutionPolicy(stage_key="loop.stage", tool_policy="MUTATON")  # typo
    with pytest.raises(StageExecutionPolicyError, match="unknown tool_policy"):
        apply_execution_policy(base, bad)


def test_unknown_context_policy_is_rejected():
    base = _base(["read_file"])
    bad = StageExecutionPolicy(stage_key="loop.stage", context_policy="STORY")  # not STORY_ONLY
    with pytest.raises(StageExecutionPolicyError, match="unknown context_policy"):
        apply_execution_policy(base, bad)


def test_unknown_value_rejected_even_when_other_dims_none():
    # Regression: the bad value must be caught BEFORE the "nothing to filter
    # on" short-circuit, otherwise it slips through to the permissive base.
    base = _base(["read_file", "apply_patch"])
    bad = StageExecutionPolicy(stage_key="loop.stage", tool_policy="bogus")
    with pytest.raises(StageExecutionPolicyError):
        apply_execution_policy(base, bad)


def test_known_values_any_case_still_filter():
    base = _base(["read_file", "apply_patch", "run_test"])
    ok = StageExecutionPolicy(stage_key="loop.stage", tool_policy="read_only")  # lowercase
    out = apply_execution_policy(base, ok)
    # READ_ONLY strips mutate tools (apply_patch) but keeps reads.
    tools = set(out.phases[Phase.ACT].allowed_tools)
    assert "read_file" in tools
    assert "apply_patch" not in tools


def test_none_and_partial_policies_pass_through():
    base = _base(["read_file"])
    # All-None override → base returned verbatim, no error.
    out = apply_execution_policy(base, StageExecutionPolicy(stage_key="loop.stage"))
    assert out is base


def test_m99_camelcase_aliases_still_populate():
    # The fail-loud change must not break the M99 alias handling.
    p = StageExecutionPolicy.model_validate({
        "stage_key": "loop.stage",
        "autoLocalize": True,
        "gitPreflightRequired": True,
    })
    assert p.auto_localize is True
    assert p.git_preflight_required is True
