"""Unit tests for the audit-gov publisher (Slice 3).

Pinned contracts:
  • Event body shape matches audit-gov's eventSchema (trace_id,
    source_service, kind, severity, payload).
  • Severity escalates with badness: pass → info, fail → warn,
    dispatch_error → error.
  • Bearer header set when AUDIT_GOV_SERVICE_TOKEN is provided,
    omitted otherwise (so a dev who hasn't configured a token can
    still run the harness without crashing).
  • Network failures bubble up as PublishResult(success=False) —
    the runner treats them as warnings, not aborts.
"""
from __future__ import annotations

from typing import Any

import pytest

from audit_publisher import (
    PublishResult,
    publish_run_completed,
    publish_run_started,
    publish_task_completed,
)


def _capturing_poster():
    """Return (poster, captured_calls) where captured_calls is a list
    of (url, body, headers, timeout) tuples — lets tests assert on
    every aspect of the wire request."""
    calls: list[tuple] = []

    def _poster(url: str, body: dict, headers: dict, timeout: float) -> dict[str, Any]:
        calls.append((url, body, headers, timeout))
        return {"id": "ev-fake", "status_code": 200}

    return _poster, calls


# ── run_started ────────────────────────────────────────────────────────────


def test_publish_run_started_emits_correct_shape() -> None:
    poster, calls = _capturing_poster()
    result = publish_run_started(
        trace_id="t-1",
        corpus_path="corpora/mini-3.json",
        task_count=3,
        model_alias="claude-haiku-4-5",
        audit_gov_url="http://audit-gov:8500",
        service_token="secret",
        _http_post=poster,
    )

    assert result.success is True
    assert result.event_id == "ev-fake"
    assert len(calls) == 1
    url, body, headers, _ = calls[0]
    assert url == "http://audit-gov:8500/api/v1/events"
    assert body["kind"] == "capability.bench_run_started"
    assert body["trace_id"] == "t-1"
    assert body["source_service"] == "capability-harness"
    assert body["severity"] == "info"
    assert body["payload"]["task_count"] == 3
    assert body["payload"]["model_alias"] == "claude-haiku-4-5"
    assert headers["authorization"] == "Bearer secret"


def test_publish_run_started_omits_bearer_when_no_token() -> None:
    """A dev without AUDIT_GOV_SERVICE_TOKEN configured should still
    be able to publish (audit-gov may have allowlisted localhost
    or run in dev mode without auth). No bearer header is set."""
    poster, calls = _capturing_poster()
    publish_run_started(
        trace_id="t-2",
        corpus_path="c.json",
        task_count=1,
        model_alias=None,
        audit_gov_url="http://x",
        service_token="",  # empty token
        _http_post=poster,
    )
    _, _, headers, _ = calls[0]
    assert "authorization" not in headers


# ── task_completed severity escalation ─────────────────────────────────────


@pytest.mark.parametrize("passed,dispatch_error,expected", [
    (True, None, "info"),
    (False, None, "warn"),
    (False, "ECONNREFUSED", "error"),
    (True, "weird-edge-case-should-not-happen", "error"),  # dispatch_error wins
])
def test_task_completed_severity_escalation(
    passed: bool, dispatch_error: str | None, expected: str,
) -> None:
    """Severity climbs with badness. Operators searching audit-gov
    for severity>=warn should find every failing task; severity>=error
    finds only the dispatch failures (the things that need ops
    attention, not just model regressions)."""
    poster, calls = _capturing_poster()
    publish_task_completed(
        trace_id="t",
        task_id="x",
        passed=passed,
        duration_ms=100,
        stop_reason="FINALIZED",
        turn_count=2,
        oracle_scores=[],
        model_alias=None,
        dispatch_error=dispatch_error,
        _http_post=poster,
    )
    _, body, _, _ = calls[0]
    assert body["severity"] == expected
    assert body["kind"] == "capability.bench_task_completed"


def test_task_completed_payload_carries_oracle_scores() -> None:
    """The per-oracle scores are the richest forensic data — pin
    that they actually make it onto the wire so the weekly cron
    (#117) can aggregate over them."""
    poster, calls = _capturing_poster()
    publish_task_completed(
        trace_id="t",
        task_id="palindrome",
        passed=True,
        duration_ms=500,
        stop_reason="FINALIZED",
        turn_count=3,
        oracle_scores=[
            {"name": "diff_matches_reference", "passed": True, "score": 0.9},
            {"name": "llm_judge", "passed": True, "score": 1.0},
            {"name": "tests_pass", "passed": True, "score": 1.0},
        ],
        model_alias="claude-sonnet-4-5",
        _http_post=poster,
    )
    _, body, _, _ = calls[0]
    assert body["payload"]["task_id"] == "palindrome"
    assert body["payload"]["passed"] is True
    assert len(body["payload"]["oracle_scores"]) == 3
    assert body["payload"]["oracle_scores"][1]["name"] == "llm_judge"


# ── run_completed ──────────────────────────────────────────────────────────


def test_publish_run_completed_carries_aggregate() -> None:
    poster, calls = _capturing_poster()
    publish_run_completed(
        trace_id="t",
        pass_count=15,
        fail_count=5,
        pass_rate=0.75,
        duration_ms=1234567,
        model_alias=None,
        _http_post=poster,
    )
    _, body, _, _ = calls[0]
    assert body["kind"] == "capability.bench_run_completed"
    assert body["severity"] == "info"
    assert body["payload"] == {
        "pass_count": 15,
        "fail_count": 5,
        "pass_rate": 0.75,
        "duration_ms": 1234567,
        "model_alias": "(default)",
    }


# ── transport failure handling ─────────────────────────────────────────────


def test_publish_returns_failure_on_transport_error() -> None:
    """A broken audit-gov should never abort the bench run.
    PublishResult(success=False) → runner logs a warning and
    continues."""
    def _broken(url, body, headers, timeout):
        raise RuntimeError("audit-gov down")

    result = publish_run_started(
        trace_id="t",
        corpus_path="c.json",
        task_count=1,
        model_alias=None,
        _http_post=_broken,
    )
    assert result.success is False
    assert result.error is not None and "audit-gov down" in result.error
    assert result.event_id is None


def test_publish_result_is_frozen() -> None:
    """Defensive: a runner can't accidentally mutate a published
    result's success field after logging it."""
    r = PublishResult(success=True, status_code=200, event_id="x", error=None)
    with pytest.raises((AttributeError, Exception)):
        r.success = False  # type: ignore[misc]
