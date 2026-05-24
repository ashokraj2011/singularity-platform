"""Unit tests for governed/receipts.py validators.

Focus: the VerificationResultPayload validator (M74 Phase 1C +
review fix #5). Other receipts have their own validators tested via
test_governed_validators.py — this file is specifically for the
verification gate's loophole protection.
"""
from __future__ import annotations

import pytest

from context_api_service.app.governed.receipts import (
    CommandResult,
    VerificationResultPayload,
)


# ── Phase 1C baseline — commands_run required for passed/failed ────────────


def test_passed_requires_commands_run() -> None:
    """Phase 1C: empty commands_run with status='passed' is an obvious
    fake-pass. The validator must reject it."""
    with pytest.raises(ValueError, match="requires commands_run to be non-empty"):
        VerificationResultPayload(status="passed", commands_run=[])


def test_failed_requires_commands_run() -> None:
    """Same applies to status='failed' — an empty list can't substantiate
    any verdict, even a failing one."""
    with pytest.raises(ValueError, match="requires commands_run to be non-empty"):
        VerificationResultPayload(status="failed", commands_run=[])


def test_unavailable_allows_empty_commands_with_reason() -> None:
    """status='unavailable' is the only path with no commands_run, but
    must carry a non-empty reason."""
    payload = VerificationResultPayload(
        status="unavailable",
        commands_run=[],
        reason="no test framework configured",
    )
    assert payload.status == "unavailable"


def test_unavailable_requires_reason() -> None:
    with pytest.raises(ValueError, match="requires a non-empty `reason`"):
        VerificationResultPayload(status="unavailable", commands_run=[])


def test_unavailable_blank_reason_rejected() -> None:
    with pytest.raises(ValueError, match="requires a non-empty `reason`"):
        VerificationResultPayload(
            status="unavailable", commands_run=[], reason="   ",
        )


# ── Review fix #5 (2026-05-23) — exit-code loophole ────────────────────────


def test_passed_with_failing_command_is_rejected() -> None:
    """REGRESSION GUARD for review fix #5.

    Before the fix, a confidently-wrong agent could submit
    status='passed' alongside a CommandResult with exit_code=1 (the
    test ACTUALLY failed) and the validator would let it through.
    The agent would then advance to SELF_REVIEW carrying the
    misleading 'passed' verdict, bypassing the verification gate.

    Now: if status='passed', every command in commands_run must have
    exit_code == 0. Otherwise raise ValueError with the failing
    command names so the auditor can see what the agent tried to
    hide.
    """
    with pytest.raises(ValueError, match="status cannot be 'passed' when underlying verifiers returned non-zero"):
        VerificationResultPayload(
            status="passed",
            commands_run=[
                CommandResult(command="pytest tests/", exit_code=1),
            ],
        )


def test_passed_with_mixed_exit_codes_is_rejected() -> None:
    """A single failure in a batch of otherwise-passing commands is
    still a failure — can't smuggle through by burying it among
    green commands."""
    with pytest.raises(ValueError, match="pytest tests/integration"):
        VerificationResultPayload(
            status="passed",
            commands_run=[
                CommandResult(command="pytest tests/unit", exit_code=0),
                CommandResult(command="pytest tests/integration", exit_code=1),
                CommandResult(command="mypy", exit_code=0),
            ],
        )


def test_passed_with_all_zero_exits_validates() -> None:
    """Happy path — every command succeeded, status='passed' is honest."""
    payload = VerificationResultPayload(
        status="passed",
        commands_run=[
            CommandResult(command="pytest tests/", exit_code=0),
            CommandResult(command="mypy", exit_code=0),
        ],
    )
    assert payload.status == "passed"
    assert len(payload.commands_run) == 2


def test_failed_with_failing_commands_validates() -> None:
    """status='failed' should accept failing commands — that's literally
    the point. The exit-code check only triggers on status='passed'."""
    payload = VerificationResultPayload(
        status="failed",
        commands_run=[
            CommandResult(command="pytest tests/", exit_code=1),
        ],
    )
    assert payload.status == "failed"


def test_failed_with_passing_commands_also_validates() -> None:
    """An agent might run several commands, some green and some red, and
    still summarise as 'failed'. The validator doesn't second-guess —
    it only enforces the inverse rule (passed requires all zero)."""
    payload = VerificationResultPayload(
        status="failed",
        commands_run=[
            CommandResult(command="lint", exit_code=0),
            CommandResult(command="test", exit_code=1),
        ],
    )
    assert payload.status == "failed"


def test_error_message_names_the_failing_commands() -> None:
    """The error message must include the names of the failing commands
    so an auditor reading audit-gov can see WHAT the agent tried to
    hide, not just that something didn't add up."""
    try:
        VerificationResultPayload(
            status="passed",
            commands_run=[
                CommandResult(command="pnpm test", exit_code=2),
                CommandResult(command="cargo check", exit_code=101),
            ],
        )
    except ValueError as exc:
        msg = str(exc)
        assert "pnpm test" in msg
        assert "cargo check" in msg
        # Specifically calls out the recovery path so the next agent
        # turn knows to switch to status='failed'.
        assert "status='failed'" in msg
    else:
        pytest.fail("expected ValueError, validator let it through")
