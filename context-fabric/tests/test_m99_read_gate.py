"""M99 S3.3 — hard full-file-read gate (pure decision fn)."""
from context_api_service.app.governed.read_gate import (
    evaluate_full_file_read_gate,
    refusal_result,
)

_POLICY_ON = {"full_file_read_requires_justification": True, "large_file_threshold_lines": 100}


def _ev(**kw):
    base = dict(
        tool_name="read_file", tool_success=True, args={}, line_count=500,
        context_policy=_POLICY_ON,
    )
    base.update(kw)
    return evaluate_full_file_read_gate(**base)


def test_refuses_oversize_unjustified_read():
    d = _ev()
    assert d.refuse is True
    assert d.line_count == 500 and d.threshold == 100
    assert "get_ast_slice" in d.reason


def test_noop_when_policy_flag_absent():
    assert _ev(context_policy={"large_file_threshold_lines": 100}).refuse is False
    assert _ev(context_policy={}).refuse is False
    assert _ev(context_policy=None).refuse is False


def test_noop_when_policy_flag_falsy():
    assert _ev(context_policy={"full_file_read_requires_justification": False,
                               "large_file_threshold_lines": 100}).refuse is False


def test_small_file_escape():
    # under threshold → never refuse
    assert _ev(line_count=50).refuse is False
    assert _ev(line_count=100).refuse is False  # exactly at threshold is OK
    assert _ev(line_count=101).refuse is True


def test_justification_escape():
    for key in ("justification", "reason", "why", "rationale"):
        assert _ev(args={key: "need whole file to trace control flow"}).refuse is False
    # empty/whitespace justification does NOT count
    assert _ev(args={"justification": "   "}).refuse is True


def test_noop_for_non_read_tools():
    assert _ev(tool_name="apply_patch").refuse is False
    assert _ev(tool_name="run_test").refuse is False


def test_noop_on_failed_read():
    assert _ev(tool_success=False).refuse is False


def test_noop_without_threshold():
    assert _ev(context_policy={"full_file_read_requires_justification": True}).refuse is False
    assert _ev(context_policy={"full_file_read_requires_justification": True,
                               "large_file_threshold_lines": 0}).refuse is False


def test_refusal_result_shape():
    d = _ev()
    env = refusal_result(d, "src/big.py")
    assert env["path"] == "src/big.py"
    assert env["read_gate_refused"] is True
    assert env["line_count"] == 500
    assert isinstance(env["content"], str) and env["content"]
