"""M74 Phase 1A — auto-verify on mutation tests.

Covers:
  • synthesize_verifier_run end-to-end via mocked dispatch_tool
  • SyntheticVerifierResult shape variants
  • _render_auto_verify_message in stage_driver
  • Helpers: _changed_paths_from_edit_receipt, _first_runnable, _summarise

The integration with the full run_stage loop is exercised indirectly
by the other governed_loop tests; here we pin the synthesis contract
in isolation so refactors don't drift it.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

from context_api_service.app.governed.dispatch import (
    ToolDispatchError,
    ToolDispatchResult,
)
from context_api_service.app.governed.stage_driver import (
    _render_auto_verify_message,
    _render_validation_error_message,
)
from context_api_service.app.governed.verify_synthesis import (
    _changed_paths_from_edit_receipt,
    _first_runnable,
    _summarise,
    synthesize_verifier_run,
)


# ── pure helpers ────────────────────────────────────────────────────────────


def test_changed_paths_extracted_from_edit_entries():
    receipt = {
        "edits": [
            {"file": "src/a.py", "edit_type": "apply_patch", "reason": "x"},
            {"file": "  src/b.py  ", "edit_type": "replace_text", "reason": "y"},
            {"file": "", "edit_type": "create_file", "reason": "empty"},
            {"file": None, "edit_type": "write_file", "reason": "none"},
            "not_a_dict",  # malformed entry
        ],
    }
    assert _changed_paths_from_edit_receipt(receipt) == ["src/a.py", "src/b.py"]


def test_changed_paths_empty_when_no_edits():
    assert _changed_paths_from_edit_receipt({}) == []
    assert _changed_paths_from_edit_receipt({"edits": []}) == []


def test_first_runnable_picks_top_of_sorted_list():
    """recommended_verification already sorts; this helper picks the
    first entry whose runnable flag is true."""
    rec = [
        {"command": "tslint", "runnable": False},
        {"command": "tsc", "runnable": True, "args": ["--noEmit"]},
        {"command": "pytest", "runnable": True},
    ]
    pick = _first_runnable(rec)
    assert pick is not None
    assert pick["command"] == "tsc"


def test_first_runnable_returns_none_when_nothing_runnable():
    rec = [
        {"command": "nonexistent", "runnable": False},
        {"command": "alsobad", "runnable": False},
    ]
    assert _first_runnable(rec) is None


def test_first_runnable_returns_none_on_empty_list():
    assert _first_runnable([]) is None


def test_summarise_truncates_long_text():
    """Updated for review fix #2 (2026-05-23). Old test asserted
    `len(out) <= max_len` against a head-truncating impl. The new
    impl keeps the tail and adds a leading marker like
    `...[truncated 1500 earlier chars]\n`, so the final length is
    `max_len + len(marker)`. The pin we care about now: the LAST
    max_len chars of the input are present in the output (where
    tracebacks live)."""
    text = "a" * 2000
    out = _summarise(text, max_len=500)
    # Tail of the input must be present in full.
    assert out.endswith("a" * 500)
    # And the marker tells the operator something was dropped.
    assert "[truncated" in out
    assert "1500" in out  # 2000 - 500 dropped chars


def test_summarise_passes_through_short_text():
    assert _summarise("short") == "short"


def test_summarise_coerces_none_to_empty():
    assert _summarise(None) == ""


# ── synthesize_verifier_run — orchestration paths ───────────────────────────


def _ok_dispatch(result: Any, *, success: bool = True) -> ToolDispatchResult:
    return ToolDispatchResult(
        result=result,
        duration_ms=42,
        tool_invocation_id="ti-test",
        tool_success=success,
        tool_error=None if success else "tool reported failure",
    )


def _run_synth(edit_receipt, fake_dispatch, **kwargs):
    """Helper: patch dispatch_tool with the fake and run synthesize_verifier_run
    via asyncio.run(). pytest-asyncio isn't installed in this project; using
    asyncio.run() inline matches the pattern in test_code_context_orchestration.py."""
    async def _go():
        with patch(
            "context_api_service.app.governed.verify_synthesis.dispatch_tool",
            new=fake_dispatch,
        ):
            return await synthesize_verifier_run(
                edit_receipt,
                work_item_id=kwargs.get("work_item_id"),
                workspace_id=kwargs.get("workspace_id"),
                run_context=kwargs.get("run_context"),
                bearer=kwargs.get("bearer", "tok"),
            )
    return asyncio.run(_go())


def test_synth_happy_path_picks_first_runnable_and_dispatches_run_test():
    """End-to-end happy: recommended_verification returns ranked list,
    first runnable picked, run_test dispatched, result wrapped."""
    rec_result = {
        "changedPaths": ["src/a.py"],
        "recommended": [
            {"command": "tsc", "args": ["--noEmit"], "runnable": True, "kind": "typecheck"},
            {"command": "pytest", "args": [], "runnable": True, "kind": "test"},
        ],
        "none_available": False,
    }
    run_result = {"exit_code": 0, "stdout": "All good", "stderr": ""}

    async def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "recommended_verification":
            return _ok_dispatch(rec_result)
        if tool_name == "run_test":
            assert args["command"] == "tsc"
            assert args["args"] == ["--noEmit"]
            return _ok_dispatch(run_result, success=True)
        raise AssertionError(f"unexpected dispatch: {tool_name}")

    edit_receipt = {
        "kind": "edit_receipt",
        "edits": [{"file": "src/a.py", "edit_type": "apply_patch", "reason": "x"}],
    }
    synth = _run_synth(edit_receipt, fake_dispatch, work_item_id="WI-1",
                       run_context={"traceId": "t1"})

    assert synth.kind == "ran"
    assert synth.command == "tsc"
    assert synth.tool_success is True
    assert synth.exit_code == 0
    assert "All good" in (synth.stdout_summary or "")


def test_synth_skipped_when_no_runnable_in_registry():
    """recommended_verification returns entries but none runnable →
    skipped, not unavailable. The agent should call
    verification_unavailable with the same reason."""
    rec_result = {
        "recommended": [{"command": "nonexistent", "runnable": False, "kind": "test"}],
        "guidance": "no runnable verifier; call verification_unavailable",
    }

    async def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "recommended_verification":
            return _ok_dispatch(rec_result)
        raise AssertionError(f"run_test should not be dispatched: {tool_name}")

    synth = _run_synth(
        {"edits": [{"file": "a.py", "edit_type": "apply_patch", "reason": "x"}]},
        fake_dispatch, workspace_id="WS-1",
    )
    assert synth.kind == "skipped"
    assert "verification_unavailable" in (synth.reason or "")


def test_synth_unavailable_when_recommended_dispatch_raises():
    """ToolDispatchError on recommended_verification → unavailable with
    diagnostic reason. Stage continues."""
    async def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "recommended_verification":
            raise ToolDispatchError("mcp-server unreachable: connection refused")
        raise AssertionError(f"unexpected: {tool_name}")

    synth = _run_synth(
        {"edits": [{"file": "a.py", "edit_type": "apply_patch", "reason": "x"}]},
        fake_dispatch, work_item_id="WI-1",
    )
    assert synth.kind == "unavailable"
    assert "recommended_verification dispatch failed" in (synth.reason or "")
    assert "connection refused" in (synth.reason or "")


def test_synth_unavailable_when_recommended_reports_failure():
    """recommended_verification returns success=false (tool-level failure)
    → unavailable with the tool's error message."""
    async def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "recommended_verification":
            return _ok_dispatch(None, success=False)
        raise AssertionError(f"unexpected: {tool_name}")

    synth = _run_synth(
        {"edits": [{"file": "a.py", "edit_type": "apply_patch", "reason": "x"}]},
        fake_dispatch, work_item_id="WI-1",
    )
    assert synth.kind == "unavailable"
    assert "recommended_verification reported failure" in (synth.reason or "")


def test_synth_unavailable_when_run_test_dispatch_raises():
    """recommended_verification picks a command but run_test dispatch
    raises → unavailable with the picked command preserved (so the
    LLM knows what we tried)."""
    rec_result = {
        "recommended": [{"command": "pytest", "args": [], "runnable": True, "kind": "test"}],
    }

    async def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "recommended_verification":
            return _ok_dispatch(rec_result)
        if tool_name == "run_test":
            raise ToolDispatchError("mcp-server returned 502")
        raise AssertionError(f"unexpected: {tool_name}")

    synth = _run_synth(
        {"edits": [{"file": "a.py", "edit_type": "apply_patch", "reason": "x"}]},
        fake_dispatch, work_item_id="WI-1",
    )
    assert synth.kind == "unavailable"
    assert synth.command == "pytest"
    assert "run_test dispatch failed" in (synth.reason or "")


def test_synth_ran_failed_propagates_exit_code():
    """run_test returned exit_code != 0 → kind="ran", tool_success=False.
    Verifier ran and gave a verdict; the verdict is "your code is broken".
    Agent should route to REPAIR."""
    rec_result = {
        "recommended": [{"command": "pytest", "args": ["-x"], "runnable": True, "kind": "test"}],
    }
    run_result = {
        "exit_code": 1,
        "stdout": "test_foo PASSED\ntest_bar FAILED",
        "stderr": "AssertionError on line 42",
    }

    async def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "recommended_verification":
            return _ok_dispatch(rec_result)
        if tool_name == "run_test":
            return _ok_dispatch(run_result, success=False)
        raise AssertionError(f"unexpected: {tool_name}")

    synth = _run_synth(
        {"edits": [{"file": "a.py", "edit_type": "apply_patch", "reason": "x"}]},
        fake_dispatch, work_item_id="WI-1",
    )
    assert synth.kind == "ran"
    assert synth.tool_success is False
    assert synth.exit_code == 1
    assert "test_bar FAILED" in (synth.stdout_summary or "")


# ── _render_auto_verify_message — prompt construction ──────────────────────


def test_render_ran_passed_includes_command_and_verdict():
    synth = {
        "kind": "ran",
        "tool_success": True,
        "command": "pytest",
        "exit_code": 0,
        "stdout_summary": "20 passed in 0.5s",
        "stderr_summary": "",
    }
    msg = _render_auto_verify_message(synth)
    assert msg["role"] == "user"
    assert "[AUTO-VERIFY]" in msg["content"]
    assert "PASSED" in msg["content"]
    assert "pytest" in msg["content"]
    assert "20 passed" in msg["content"]


def test_render_ran_failed_says_failed_and_steers_to_repair():
    synth = {
        "kind": "ran",
        "tool_success": False,
        "command": "tsc --noEmit",
        "exit_code": 1,
        "stderr_summary": "Type error in foo.ts",
    }
    msg = _render_auto_verify_message(synth)
    assert "FAILED" in msg["content"]
    assert "REPAIR" in msg["content"]
    assert "Type error" in msg["content"]


def test_render_skipped_directs_to_verification_unavailable():
    synth = {"kind": "skipped", "reason": "no runnable verifier"}
    msg = _render_auto_verify_message(synth)
    assert "verification_unavailable" in msg["content"]
    assert "no runnable verifier" in msg["content"]


def test_render_unavailable_says_synthesis_failed():
    synth = {"kind": "unavailable", "reason": "mcp-server returned 502"}
    msg = _render_auto_verify_message(synth)
    assert "synthesis failed" in msg["content"]
    assert "mcp-server returned 502" in msg["content"]


def test_render_unknown_kind_falls_back_to_unavailable_template():
    """Defensive: a future kind we don't yet render should not crash the
    history extension — fall through to the unavailable template."""
    synth = {"kind": "novel_future_kind", "reason": "some reason"}
    msg = _render_auto_verify_message(synth)
    assert msg["role"] == "user"
    assert msg["content"]


# ── Review fix #2 (2026-05-23) — _summarise keeps tail, not head ────────────


def test_summarise_short_text_returned_verbatim():
    """Below the threshold, no truncation. Pin in case the impl
    is refactored to always-truncate."""
    s = "short string"
    assert _summarise(s, max_len=1500) == s


def test_summarise_preserves_tail_where_tracebacks_live():
    """REGRESSION GUARD for review fix #2.

    Before the fix, _summarise kept the HEAD of the buffer. That
    discarded the actual pytest/jest assertion failure (which is
    always near the END of the output) and only showed the setup
    logs. The LLM saw "the run failed" but no reason, so self-
    repair couldn't engage.

    Now _summarise keeps the TAIL. The test simulates pytest
    output: lots of innocuous setup chatter, then a clear failure
    line at the bottom. The summary MUST include the failure line.
    """
    setup_noise = "rootdir: /work\n" * 500  # ~7KB of innocuous head
    failure = (
        "FAILED tests/test_x.py::test_basic\n"
        "AssertionError: expected 5, got -1\n"
        "  assert add(2, 3) == 5\n"
        "1 failed in 0.04s\n"
    )
    text = setup_noise + failure
    summary = _summarise(text, max_len=1500)

    assert "AssertionError" in summary, (
        "Tail not preserved — _summarise has regressed to head-truncation. "
        "Test failures live at the END of the output buffer; the LLM cannot "
        "self-repair without seeing them."
    )
    assert "FAILED tests/test_x.py" in summary
    assert "1 failed in 0.04s" in summary
    # And the truncation marker should be at the START, signalling
    # "we dropped earlier content" rather than "we dropped later content".
    assert summary.startswith("...[truncated")


def test_summarise_truncation_marker_includes_dropped_count():
    """The marker tells the operator how much was discarded, useful
    when grepping for "tail-only" outputs in JSONL dumps."""
    text = "x" * 5000
    summary = _summarise(text, max_len=1500)
    assert "[truncated" in summary
    # 5000 - 1500 = 3500 chars dropped from the head.
    assert "3500" in summary


def test_summarise_handles_none() -> None:
    assert _summarise(None) == ""


def test_summarise_coerces_non_string_input() -> None:
    """Verifier might pass an int exit_code or dict — must not crash."""
    assert _summarise(42, max_len=1500) == "42"
    assert "key" in _summarise({"key": "value"}, max_len=1500)


# ── Review fix #3 (2026-05-23) — _render_validation_error_message ───────────


def test_render_validation_error_includes_phase_and_reason() -> None:
    """The message must carry phase + reason so the LLM knows which
    receipt to fix."""
    err = {
        "phase": "PLAN",
        "reason": "missing required field 'target_files'",
        "details": [],
    }
    msg = _render_validation_error_message(err)
    assert msg["role"] == "user"
    assert "PLAN" in msg["content"]
    assert "missing required field" in msg["content"]
    assert "submit_phase_output" in msg["content"]


def test_render_validation_error_lists_per_field_details() -> None:
    """When the validator returns structured per-field errors, the
    rendered message must list them so the LLM can fix each one."""
    err = {
        "phase": "PLAN",
        "reason": "schema violations",
        "details": [
            {"loc": "target_files", "msg": "field required"},
            {"loc": "test_strategy.commands", "msg": "must be non-empty"},
        ],
    }
    msg = _render_validation_error_message(err)
    assert "target_files" in msg["content"]
    assert "field required" in msg["content"]
    assert "test_strategy.commands" in msg["content"]


def test_render_validation_error_warns_about_retry_budget() -> None:
    """The message tells the LLM it has one retry attempt — gives
    the model a fair chance to allocate its remaining tokens to a
    correct submission rather than re-burning them on the broken
    shape."""
    msg = _render_validation_error_message({"phase": "PLAN", "reason": "x"})
    assert "one retry" in msg["content"]
    assert "VALIDATION_BLOCKED" in msg["content"]


def test_render_validation_error_handles_non_dict_gracefully() -> None:
    """Defensive: a future error shape we don't recognise shouldn't
    crash the loop. Renders a generic fallback message."""
    msg = _render_validation_error_message("string error")
    assert msg["role"] == "user"
    assert "string error" in msg["content"]
    assert "Re-submit" in msg["content"]


def test_render_validation_error_caps_detail_count() -> None:
    """An overzealous validator could return hundreds of per-field
    errors; the message caps at 10 to keep the prompt bounded."""
    err = {
        "phase": "PLAN",
        "reason": "many errors",
        "details": [{"loc": f"field_{i}", "msg": "bad"} for i in range(50)],
    }
    msg = _render_validation_error_message(err)
    # Detail lines start with "  - "; count them.
    detail_lines = [
        line for line in msg["content"].splitlines() if line.startswith("  - ")
    ]
    assert len(detail_lines) == 10
