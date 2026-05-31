"""M99 S3.2 — policy-facts markdown renderer (turn._render_policy_facts)."""
from context_api_service.app.governed.turn import _render_policy_facts


def test_empty_when_no_facts():
    assert _render_policy_facts({}, {}) == ""
    assert _render_policy_facts({"ast_first": False}, {}) == ""


def test_ast_first_fact():
    out = _render_policy_facts({"ast_first": True}, {})
    assert out.startswith("## Policy & context facts")
    assert "AST tools" in out


def test_hard_read_gate_fact():
    out = _render_policy_facts(
        {"full_file_read_requires_justification": True, "large_file_threshold_lines": 300}, {}
    )
    assert "300 lines are REFUSED" in out
    assert "justification" in out


def test_soft_threshold_fact_without_justification_flag():
    out = _render_policy_facts({"large_file_threshold_lines": 300}, {})
    assert "300 lines are flagged" in out
    assert "REFUSED" not in out


def test_require_context_receipt_fact():
    out = _render_policy_facts({"require_context_receipt": True}, {})
    assert "ContextReceipt" in out


def test_localization_summary_included():
    out = _render_policy_facts(
        {"ast_first": True},
        {"localization_summary": "localized 3 files, 1 symbol"},
    )
    assert "Localization: localized 3 files, 1 symbol" in out


def test_all_facts_compose():
    out = _render_policy_facts(
        {
            "ast_first": True,
            "full_file_read_requires_justification": True,
            "large_file_threshold_lines": 500,
            "require_context_receipt": True,
        },
        {"localization_summary": "x"},
    )
    # one header + 4 bullet lines
    assert out.count("\n- ") == 4
    assert out.count("## Policy & context facts") == 1
