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
             limits: dict | None = None,
             stage_context_policy: str | None = None,
             stage_tool_policy: str | None = None,
             stage_repo_access: bool | None = None) -> SimpleNamespace:
    """Minimal stand-in for ExecuteRequest — only the fields the helper reads."""
    vars = {
        "agentRole": agent_role,
        "stageKey": stage_key,
        "stageLabel": stage_label,
    }
    if stage_context_policy is not None:
        vars["stageContextPolicy"] = stage_context_policy
    if stage_tool_policy is not None:
        vars["stageToolPolicy"] = stage_tool_policy
    if stage_repo_access is not None:
        vars["stageRepoAccess"] = stage_repo_access
    return SimpleNamespace(
        vars=vars,
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


RESEARCH_ONLY_TOOL_NAMES = {
    "read_file", "search_code", "index_workspace",
    "find_symbol", "get_symbol", "repo_map",
}

# M55 — path-walking / enumeration tools that should NOT be exposed to
# non-code stages because those stages run at the platform sandbox root
# and the tools invite path hallucination.
PATH_WALKER_TOOL_NAMES = {
    "find_files", "list_directory", "list_indexed_files",
    "get_ast_slice", "get_dependencies", "file_stats", "grep_lines",
}


def test_non_code_stage_gets_research_only_subset():
    """STORY_INTAKE / PLAN / DESIGN stages — tight research subset.
    Excludes path-walking tools that caused trace-time hallucinations
    (agent inventing `org/example/model/...` subdirs that don't exist)."""
    tools = _mandatory_local_tools_for_request(make_req(agent_role="ARCHITECT", task="design"))
    n = names(tools)
    # Still excluded: verification, mutation, review (M43 baseline)
    assert n.isdisjoint(MUTATION_TOOL_NAMES)
    assert n.isdisjoint(VERIFY_TOOL_NAMES)
    assert n.isdisjoint(REVIEW_TOOL_NAMES)
    # The research-only set is EXACTLY these six tools.
    assert n == RESEARCH_ONLY_TOOL_NAMES, (
        f"non-code stage should expose exactly the research-only set; "
        f"diff: extra={n - RESEARCH_ONLY_TOOL_NAMES}, missing={RESEARCH_ONLY_TOOL_NAMES - n}"
    )
    # Spot-check the explicit exclusions that were causing the bug.
    assert n.isdisjoint(PATH_WALKER_TOOL_NAMES), (
        f"path-walking tools must not be exposed to non-code stages "
        f"(would re-introduce M55 hallucination): {n & PATH_WALKER_TOOL_NAMES}"
    )


def test_non_code_stage_classifier_covers_architect():
    """DESIGN (ARCHITECT) classifies as non-code and gets the tight
    research subset unless workflow stage policy says STORY_ONLY."""
    for role in ("ARCHITECT",):
        tools = _mandatory_local_tools_for_request(make_req(agent_role=role))
        n = names(tools)
        assert n == RESEARCH_ONLY_TOOL_NAMES, f"{role} should get research-only set"


def test_story_only_stage_gets_no_tools():
    tools = _mandatory_local_tools_for_request(make_req(
        agent_role="PRODUCT_OWNER",
        stage_key="intake",
        stage_context_policy="STORY_ONLY",
        stage_tool_policy="NONE",
        stage_repo_access=False,
    ))
    assert names(tools) == set()


def test_stage_policy_overrides_role_for_read_only_plan():
    tools = _mandatory_local_tools_for_request(make_req(
        agent_role="PRODUCT_OWNER",
        stage_key="plan",
        stage_context_policy="REPO_READ_ONLY",
        stage_tool_policy="READ_ONLY",
        stage_repo_access=True,
    ))
    assert names(tools) == RESEARCH_ONLY_TOOL_NAMES


def test_stage_policy_overrides_role_for_code_edit():
    is_dev, is_qa = _classify_stage_role(make_req(
        agent_role="ARCHITECT",
        stage_context_policy="CODE_EDIT",
        stage_tool_policy="MUTATION",
    ))
    assert is_dev is True
    assert is_qa is False


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


# ── M44 Slice B — canonical-list completeness ──────────────────────────────
# With includeLocalTools defaulting to false, the canonical list emitted by
# context-fabric IS the agent's full tool surface. Any tool the LLM should
# be able to call MUST be declared here. The test fails loudly if someone
# adds a new tool to mcp-server's registry but forgets to declare it in
# context-fabric.

# This is the curated "must be exposed to a coding agent" subset of
# mcp-server's REGISTRY. Demo/laptop-only/system-internal tools are
# deliberately excluded.
EXPECTED_CODING_AGENT_TOOLS = {
    # base read + AST
    "read_file", "search_code", "index_workspace", "find_symbol",
    "get_symbol", "get_ast_slice", "get_dependencies",
    "list_directory", "list_indexed_files",
    # discovery fallback (M42.8)
    "find_files", "file_stats", "grep_lines",
    # workflow grounding (M43)
    "repo_map",
    # verification
    "recommended_verification", "run_test", "run_command",
    "verification_unavailable", "formal_verify",
    # review (M43)
    "review_diff",
    # mutation (dev only — but must be DECLARED in canonical list)
    "apply_patch", "replace_text", "replace_range", "write_file",
    # workflow completion
    "git_commit", "finish_work_branch",
}


def test_canonical_list_covers_every_coding_agent_tool():
    """Every tool a coding agent should be able to call MUST be in the
    canonical Dev list. With M44's includeLocalTools=false default, anything
    omitted here is invisible to the LLM."""
    tools = _mandatory_local_tools_for_request(make_req(agent_role="DEVELOPER"))
    n = names(tools)
    missing = EXPECTED_CODING_AGENT_TOOLS - n
    assert not missing, (
        f"Coding-agent tools missing from canonical Dev list: {sorted(missing)}. "
        f"Either add them to _mandatory_local_tools_for_request or, if they're "
        f"intentionally laptop/demo/system-only, remove them from "
        f"EXPECTED_CODING_AGENT_TOOLS."
    )


def test_qa_canonical_list_covers_read_and_verify():
    """QA stages must still see every read + verify tool (just not mutations)."""
    qa_expected = EXPECTED_CODING_AGENT_TOOLS - MUTATION_TOOL_NAMES
    tools = _mandatory_local_tools_for_request(make_req(agent_role="QA"))
    n = names(tools)
    missing = qa_expected - n
    assert not missing, f"QA canonical list missing: {sorted(missing)}"
