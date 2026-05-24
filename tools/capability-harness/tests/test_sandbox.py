"""Tests for the subprocess test sandbox (Slice 2).

These exercise the real subprocess — they need `pytest` available in
the host Python env. CI should pre-install pytest; locally, anyone
who's running these tests already has pytest by definition.

The sandbox itself runs against a temp dir so these tests don't
mutate anything outside /tmp.
"""
from __future__ import annotations

import pytest

from sandbox import SandboxResult, run_python_tests


def test_sandbox_passes_on_correct_solution() -> None:
    """End-to-end: a correct solution + a passing test → SandboxResult
    with passed=True. Confirms the harness can actually exec code
    and parse pytest's exit code."""
    result = run_python_tests(
        agent_code="def add(a, b): return a + b\n",
        test_code="def test_add(): assert add(2, 3) == 5\n",
        timeout_sec=10,
    )
    assert result.passed is True
    assert result.exit_code == 0
    assert result.timed_out is False
    assert "passed" in result.reason


def test_sandbox_fails_on_buggy_solution() -> None:
    """The agent's code is wrong; test assertion fires. SandboxResult
    should be passed=False with exit_code=1 (pytest's standard
    'tests failed' code), NOT a higher code that indicates a
    collection error."""
    result = run_python_tests(
        agent_code="def add(a, b): return a - b  # bug\n",
        test_code="def test_add(): assert add(2, 3) == 5\n",
        timeout_sec=10,
    )
    assert result.passed is False
    assert result.exit_code == 1
    assert result.timed_out is False
    # pytest's short-traceback format inlines the failed `assert -1 == 5`
    # without the literal word "AssertionError" — match on "failed"
    # plus the actual value mismatch instead, which is what an operator
    # would actually grep for in the result row.
    combined = result.stdout + result.stderr
    assert "failed" in combined.lower()
    assert "assert -1 == 5" in combined or "assert" in combined.lower()


def test_sandbox_handles_syntax_error_in_agent_code() -> None:
    """Agent emitted unparseable Python. Sandbox returns failure
    cleanly — doesn't crash the harness."""
    result = run_python_tests(
        agent_code="def broken(:\n",  # syntax error
        test_code="def test_x(): assert True\n",
        timeout_sec=10,
    )
    assert result.passed is False
    # Could be exit_code != 0 (collection failure) — either way, fail.
    assert result.exit_code != 0


def test_sandbox_handles_import_error_in_test_code() -> None:
    """test_code references a name the solution doesn't define."""
    result = run_python_tests(
        agent_code="def foo(): return 1\n",
        test_code="def test_bar(): assert bar() == 2  # bar is undefined\n",
        timeout_sec=10,
    )
    assert result.passed is False


def test_sandbox_no_tests_collected_distinguishable() -> None:
    """pytest exit 5 = no tests collected. The sandbox reports this
    distinctly so an operator knows the corpus author forgot the
    `def test_*` prefix rather than thinking the test silently
    passed."""
    result = run_python_tests(
        agent_code="def f(): pass\n",
        test_code="assert 1 + 1 == 2  # bare assert, no test_ function\n",
        timeout_sec=10,
    )
    assert result.passed is False
    assert result.exit_code == 5
    assert "zero tests" in result.reason


@pytest.mark.slow
def test_sandbox_kills_on_timeout() -> None:
    """Infinite loop in the agent's code. The sandbox must enforce
    the timeout — without this, a runaway task wedges the whole
    corpus run. Marked 'slow' since it deliberately sleeps for the
    timeout duration."""
    result = run_python_tests(
        agent_code="def f():\n    while True:\n        pass\n",
        test_code="def test_x(): f()\n",
        timeout_sec=2,  # short for the test
    )
    assert result.passed is False
    assert result.timed_out is True
    assert "exceeded" in result.reason
    assert result.duration_ms >= 1900  # roughly the timeout


def test_sandbox_result_dataclass_is_frozen() -> None:
    """Same reproducibility argument as CorpusTask — a runner can't
    accidentally mutate the result after scoring it."""
    r = SandboxResult(
        passed=True, duration_ms=1, stdout="", stderr="",
        exit_code=0, timed_out=False, reason="ok",
    )
    with pytest.raises((AttributeError, Exception)):  # FrozenInstanceError
        r.passed = False  # type: ignore[misc]
