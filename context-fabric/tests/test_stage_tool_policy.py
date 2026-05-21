"""
M43 — verify that QA-tagged stages do NOT receive mutation tools in the
canonical tool list emitted by `_mandatory_local_tools_for_request`.

Before M43, the helper conflated "is_code_stage" so any stage labelled with
qa/quality/test/verify got the full mutation suite (apply_patch, write_file,
git_commit, finish_work_branch). This test pins the corrected behaviour:
QA stages see read + verification + review tools only; Dev stages still get
the full surface.
"""
from types import SimpleNamespace

import pytest

from context_api_service.app.execute import (
    _classify_stage_role,
    _mandatory_local_tools_for_request,
)


def make_req(*, agent_role: str = "", stage_key: str = "", stage_label: str = "",
             task: str = "", allow_autonomous_mutation: bool = False,
             limits: dict | None = None) -> SimpleNamespace:
    """Minimal stand-in for ExecuteRequest — only the fields the helper reads."""
    return SimpleNamespace(
        vars={
            "agentRole": agent_role,
            "stageKey": stage_key,
            "stageLabel": stage_label,
        },
        task=task,
        allow_autonomous_mutation=allow_autonomous_mutation,
        limits=limits or {},
    )


MUTATION_TOOL_NAMES = {
    "apply_patch", "replace_text", "replace_range", "write_file",
    "git_commit", "finish_work_branch",
}
VERIFY_TOOL_NAMES = {
    "recommended_verification", "run_test", "run_command",
    "verification_unavailable", "formal_verify",
}
REVIEW_TOOL_NAMES = {"review_diff"}
WORKFLOW_GROUNDING_TOOLS = {"repo_map", "list_indexed_files"}


def names(tools: list[dict]) -> set[str]:
    return {t["name"] for t in tools}


def test_classify_dev_stage():
    is_dev, is_qa = _classify_stage_role(make_req(agent_role="DEVELOPER"))
    assert is_dev is True
    assert is_qa is False


def test_classify_qa_stage():
    is_dev, is_qa = _classify_stage_role(make_req(agent_role="QA"))
    assert is_dev is False
    assert is_qa is True


def test_classify_qa_with_autonomous_mutation_is_dev():
    """Edge case: a QA stage with allow_autonomous_mutation=True is treated
    as Dev (mutation wins). This is the rare case where ops explicitly opts
    a QA stage into mutation."""
    is_dev, is_qa = _classify_stage_role(make_req(agent_role="QA", allow_autonomous_mutation=True))
    assert is_dev is True
    assert is_qa is False


def test_classify_plan_stage_is_neither():
    is_dev, is_qa = _classify_stage_role(make_req(agent_role="ARCHITECT", task="plan the work"))
    assert is_dev is False
    assert is_qa is False


def test_dev_stage_gets_mutation_tools():
    tools = _mandatory_local_tools_for_request(make_req(agent_role="DEVELOPER"))
    n = names(tools)
    # Dev sees the full set
    assert MUTATION_TOOL_NAMES.issubset(n), f"missing mutation tools: {MUTATION_TOOL_NAMES - n}"
    assert VERIFY_TOOL_NAMES.issubset(n)
    assert REVIEW_TOOL_NAMES.issubset(n)
    assert WORKFLOW_GROUNDING_TOOLS.issubset(n)


def test_qa_stage_excludes_mutation_tools():
    tools = _mandatory_local_tools_for_request(make_req(agent_role="QA"))
    n = names(tools)
    # QA does NOT see any mutation tool
    assert n.isdisjoint(MUTATION_TOOL_NAMES), \
        f"QA stage should not see mutation tools, but got: {n & MUTATION_TOOL_NAMES}"
    # QA DOES see verification + review + grounding
    assert VERIFY_TOOL_NAMES.issubset(n), f"QA missing verify tools: {VERIFY_TOOL_NAMES - n}"
    assert REVIEW_TOOL_NAMES.issubset(n), f"QA missing review tools: {REVIEW_TOOL_NAMES - n}"
    assert WORKFLOW_GROUNDING_TOOLS.issubset(n), f"QA missing grounding tools: {WORKFLOW_GROUNDING_TOOLS - n}"


def test_non_code_stage_gets_grounding_only():
    """PLAN / DESIGN stages — no verification, no mutation, only research tools."""
    tools = _mandatory_local_tools_for_request(make_req(agent_role="ARCHITECT", task="design"))
    n = names(tools)
    assert n.isdisjoint(MUTATION_TOOL_NAMES)
    assert n.isdisjoint(VERIFY_TOOL_NAMES)
    assert n.isdisjoint(REVIEW_TOOL_NAMES)
    # But base read/AST tools are always present
    assert "read_file" in n
    assert "search_code" in n
    assert "index_workspace" in n
    assert "find_symbol" in n


def test_m43_tools_present_for_all_code_stages():
    """repo_map / review_diff / recommended_verification must be visible to
    both Dev (for use) and QA (for inspection)."""
    for role in ("DEVELOPER", "QA"):
        tools = _mandatory_local_tools_for_request(make_req(agent_role=role))
        n = names(tools)
        assert "repo_map" in n, f"{role} missing repo_map"
        if role == "DEVELOPER" or role == "QA":
            assert "review_diff" in n, f"{role} missing review_diff"
            assert "recommended_verification" in n, f"{role} missing recommended_verification"


def test_m42_fallback_tools_present():
    """find_files / file_stats / grep_lines belong to every code stage as
    explicit fallbacks for non-indexed file inspection."""
    tools = _mandatory_local_tools_for_request(make_req(agent_role="DEVELOPER"))
    n = names(tools)
    assert {"find_files", "file_stats", "grep_lines"}.issubset(n)
