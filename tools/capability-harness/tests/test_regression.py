"""Unit tests for the regression detector (Phase 4B / task #117).

Pinned contracts:
  • Per-model grouping: a Haiku regression does NOT fire an alert
    for Sonnet runs.
  • Trailing-window baseline: a single noisy run shouldn't trigger;
    a real decline against the prior N-mean should.
  • Threshold semantics: 0.05 means 5pp absolute drop, not 5%
    relative — pin this so a future refactor doesn't quietly
    change the meaning.
  • Not-enough-history → empty findings (no false positives on a
    brand-new model that's only run once).
  • Alert event shape matches the documented payload spec.

History is injected via the `_history_loader` seam so tests don't
need a running audit-gov.
"""
from __future__ import annotations

from typing import Any

import pytest

from regression import (
    BenchRunPoint,
    RegressionFinding,
    detect_regressions,
    emit_regression_alert,
)


def _runs(model: str, rates: list[float]) -> list[BenchRunPoint]:
    """Build a sequence of BenchRunPoints with synthetic timestamps."""
    return [
        BenchRunPoint(
            created_at=f"2026-05-{20 + i:02d}T00:00:00+00:00",
            model_alias=model,
            pass_rate=rate,
            pass_count=int(rate * 20),
            fail_count=20 - int(rate * 20),
            trace_id=f"trace-{model}-{i}",
        )
        for i, rate in enumerate(rates)
    ]


def _loader_returning(points: list[BenchRunPoint]) -> Any:
    def _loader(**_kwargs):
        return points
    return _loader


# ── detect_regressions ─────────────────────────────────────────────────────


def test_no_regression_when_pass_rate_steady() -> None:
    points = _runs("haiku", [0.80, 0.81, 0.79, 0.80, 0.80])
    findings = detect_regressions(_history_loader=_loader_returning(points))
    assert findings == []


def test_no_regression_when_pass_rate_improves() -> None:
    """A jump in the right direction is never an alert."""
    points = _runs("haiku", [0.50, 0.60, 0.55, 0.60, 0.95])
    findings = detect_regressions(_history_loader=_loader_returning(points))
    assert findings == []


def test_regression_flagged_on_clear_drop() -> None:
    """Baseline of last 4 runs averages 0.80; current drops to 0.70
    → 10pp drop, above the default 5pp threshold."""
    points = _runs("haiku", [0.80, 0.80, 0.80, 0.80, 0.70])
    findings = detect_regressions(_history_loader=_loader_returning(points))
    assert len(findings) == 1
    f = findings[0]
    assert f.model_alias == "haiku"
    assert f.current_pass_rate == pytest.approx(0.70)
    assert f.baseline_pass_rate == pytest.approx(0.80)
    assert f.drop == pytest.approx(0.10)
    assert f.baseline_window_size == 4
    assert f.current_trace_id == "trace-haiku-4"


def test_no_regression_when_drop_below_threshold() -> None:
    """4pp drop on the default 5pp threshold → not flagged. Single
    noisy run shouldn't trigger an alert."""
    points = _runs("haiku", [0.80, 0.80, 0.80, 0.80, 0.76])
    findings = detect_regressions(_history_loader=_loader_returning(points))
    assert findings == []


def test_custom_threshold_strictness() -> None:
    """Same data with a stricter 3pp threshold should flag."""
    points = _runs("haiku", [0.80, 0.80, 0.80, 0.80, 0.76])
    findings = detect_regressions(
        threshold=0.03,
        _history_loader=_loader_returning(points),
    )
    assert len(findings) == 1


def test_per_model_isolation() -> None:
    """Haiku regresses but Sonnet improves — only the Haiku finding
    should fire. A regression on one model doesn't generate noise
    on the others."""
    haiku_pts = _runs("haiku", [0.85, 0.85, 0.85, 0.85, 0.60])
    sonnet_pts = _runs("sonnet", [0.70, 0.75, 0.80, 0.85, 0.95])
    findings = detect_regressions(
        _history_loader=_loader_returning(haiku_pts + sonnet_pts),
    )
    assert len(findings) == 1
    assert findings[0].model_alias == "haiku"


def test_insufficient_history_returns_empty() -> None:
    """Brand-new model with only 1 run has no baseline → no
    finding. Avoids false positives on first-ever runs."""
    points = _runs("brand-new", [0.50])
    findings = detect_regressions(_history_loader=_loader_returning(points))
    assert findings == []


def test_window_caps_at_configured_size() -> None:
    """Window=2 means baseline averages only the 2 immediately-
    prior runs, not all history. Pins the windowing logic."""
    # 0.50 0.50 [0.95 0.95] [0.70 ← current]
    # With window=2, baseline = mean(0.95, 0.95) = 0.95
    # Drop = 0.95 - 0.70 = 0.25 (flagged)
    points = _runs("x", [0.50, 0.50, 0.95, 0.95, 0.70])
    findings = detect_regressions(
        window_runs=2,
        _history_loader=_loader_returning(points),
    )
    assert len(findings) == 1
    assert findings[0].baseline_pass_rate == pytest.approx(0.95)
    assert findings[0].baseline_window_size == 2


def test_history_ordering_by_created_at() -> None:
    """detect_regressions sorts by created_at — out-of-order input
    must still produce the correct 'current = newest' result."""
    # Reversed order: newest first in input.
    pts = list(reversed(_runs("haiku", [0.80, 0.80, 0.80, 0.80, 0.60])))
    findings = detect_regressions(_history_loader=_loader_returning(pts))
    assert len(findings) == 1
    assert findings[0].current_pass_rate == pytest.approx(0.60)


# ── emit_regression_alert ──────────────────────────────────────────────────


def test_alert_event_shape() -> None:
    captured: list[tuple] = []

    def _poster(url, body, headers, timeout):
        captured.append((url, body, headers))
        return {}

    finding = RegressionFinding(
        model_alias="haiku",
        current_pass_rate=0.60,
        baseline_pass_rate=0.85,
        drop=0.25,
        current_trace_id="trace-x",
        baseline_window_size=4,
    )
    ok = emit_regression_alert(
        finding=finding,
        audit_gov_url="http://audit-gov:8500",
        service_token="tok",
        _http_post=_poster,
    )
    assert ok is True
    url, body, headers = captured[0]
    assert url == "http://audit-gov:8500/api/v1/events"
    assert body["kind"] == "capability.bench_regression_alert"
    assert body["severity"] == "error"
    assert body["source_service"] == "capability-harness"
    assert body["trace_id"] == "trace-x"
    assert body["payload"]["model_alias"] == "haiku"
    assert body["payload"]["drop"] == pytest.approx(0.25)
    assert "haiku pass_rate dropped from 85.0% to 60.0%" in body["payload"]["summary"]
    assert headers["authorization"] == "Bearer tok"


def test_alert_returns_false_on_transport_error() -> None:
    """Audit-gov down → return False, don't raise. The cron caller
    logs but doesn't crash."""
    def _broken(url, body, headers, timeout):
        raise RuntimeError("connection refused")

    finding = RegressionFinding(
        model_alias="m", current_pass_rate=0.5, baseline_pass_rate=0.8,
        drop=0.3, current_trace_id="t", baseline_window_size=4,
    )
    ok = emit_regression_alert(finding=finding, _http_post=_broken)
    assert ok is False


def test_alert_omits_bearer_when_no_token() -> None:
    captured: list[tuple] = []

    def _poster(url, body, headers, timeout):
        captured.append((url, body, headers))
        return {}

    finding = RegressionFinding(
        model_alias="m", current_pass_rate=0.5, baseline_pass_rate=0.8,
        drop=0.3, current_trace_id="t", baseline_window_size=4,
    )
    emit_regression_alert(
        finding=finding,
        service_token="",
        _http_post=_poster,
    )
    _, _, headers = captured[0]
    assert "authorization" not in headers
