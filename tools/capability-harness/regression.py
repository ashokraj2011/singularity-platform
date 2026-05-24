"""Regression detector for the capability harness (Phase 4B).

Reads bench history from audit-gov's events store, compares the most
recent `capability.bench_run_completed` event against the trailing
window (default last 4 weekly runs), and flags any per-model
pass-rate drop >= the configured threshold.

Emits `capability.bench_regression_alert` events when a regression is
detected — those events ride the audit-gov SSE channel so an
operator dashboard or pager can react in real time.

Separation of concerns:
  • runner.py emits the per-run data (Slice 3).
  • regression.py reads it back, computes the diff, emits an alert.
  • A cron / scheduled-task fires regression.py after every run.

Design choices:
  • Trailing-window mean as the baseline (not last-run-only) so a
    single noisy run doesn't trigger an alert and a steady decline
    is more visible than a one-step drop.
  • Per-model alerts. A model regression on Haiku doesn't fire an
    alert for Sonnet runs.
  • Threshold defaults to 0.05 (5pp absolute drop) per the spec.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


_DEFAULT_AUDIT_GOV_URL = "http://localhost:8500"
_DEFAULT_WINDOW_RUNS = 4
_DEFAULT_THRESHOLD = 0.05  # 5pp absolute drop in pass_rate
_DEFAULT_LOOKBACK_DAYS = 35  # weekly cron × ~4 runs + safety buffer


@dataclass(frozen=True)
class BenchRunPoint:
    """One historical run's headline metric for trend computation."""

    created_at: str  # ISO8601
    model_alias: str
    pass_rate: float
    pass_count: int
    fail_count: int
    trace_id: str


@dataclass(frozen=True)
class RegressionFinding:
    """One detected regression worth alerting on."""

    model_alias: str
    current_pass_rate: float
    baseline_pass_rate: float
    drop: float                 # baseline - current (positive number)
    current_trace_id: str
    baseline_window_size: int   # how many historical runs informed the baseline


def detect_regressions(
    *,
    window_runs: int = _DEFAULT_WINDOW_RUNS,
    threshold: float = _DEFAULT_THRESHOLD,
    lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
    audit_gov_url: str | None = None,
    service_token: str | None = None,
    _history_loader: Any = None,
) -> list[RegressionFinding]:
    """Fetch recent bench history, compute per-model trailing-window
    mean, return any (current, baseline) pair whose drop >= threshold.

    Returns an empty list when there isn't enough history yet
    (need at least 2 runs per model to make any comparison).
    """
    loader = _history_loader or _default_history_loader
    history = loader(
        audit_gov_url=audit_gov_url,
        service_token=service_token,
        lookback_days=lookback_days,
    )

    # Group by model_alias, sorted oldest-first within each group so
    # the most recent is .pop().
    by_model: dict[str, list[BenchRunPoint]] = {}
    for point in sorted(history, key=lambda p: p.created_at):
        by_model.setdefault(point.model_alias, []).append(point)

    findings: list[RegressionFinding] = []
    for model, runs in by_model.items():
        if len(runs) < 2:
            continue
        current = runs[-1]
        # Window = the N runs immediately preceding the current one.
        # Empty window → can't compute a baseline → skip.
        prior = runs[-(1 + window_runs):-1] if len(runs) > 1 else []
        if not prior:
            continue
        baseline = sum(p.pass_rate for p in prior) / len(prior)
        drop = baseline - current.pass_rate
        if drop >= threshold:
            findings.append(RegressionFinding(
                model_alias=model,
                current_pass_rate=current.pass_rate,
                baseline_pass_rate=baseline,
                drop=drop,
                current_trace_id=current.trace_id,
                baseline_window_size=len(prior),
            ))
    return findings


def emit_regression_alert(
    *,
    finding: RegressionFinding,
    audit_gov_url: str | None = None,
    service_token: str | None = None,
    _http_post: Any = None,
) -> bool:
    """Post a `capability.bench_regression_alert` event to audit-gov.
    Severity is 'error' so it shows up in the operator's default
    severity>=warn dashboard filter. Returns True on success."""
    base = (audit_gov_url or os.environ.get("AUDIT_GOV_URL", _DEFAULT_AUDIT_GOV_URL)).rstrip("/")
    token = service_token or os.environ.get("AUDIT_GOV_SERVICE_TOKEN", "")
    body = {
        "trace_id": finding.current_trace_id,
        "source_service": "capability-harness",
        "kind": "capability.bench_regression_alert",
        "severity": "error",
        "payload": {
            "model_alias": finding.model_alias,
            "current_pass_rate": finding.current_pass_rate,
            "baseline_pass_rate": finding.baseline_pass_rate,
            "drop": finding.drop,
            "baseline_window_size": finding.baseline_window_size,
            "summary": (
                f"{finding.model_alias} pass_rate dropped from "
                f"{finding.baseline_pass_rate * 100:.1f}% to "
                f"{finding.current_pass_rate * 100:.1f}% "
                f"(window={finding.baseline_window_size} runs)"
            ),
        },
    }
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    poster = _http_post or _default_event_poster
    try:
        poster(f"{base}/api/v1/events", body, headers, 10.0)
        return True
    except Exception:  # noqa: BLE001 — best-effort alerting
        return False


# ── history loader ─────────────────────────────────────────────────────────


def _default_history_loader(
    *,
    audit_gov_url: str | None,
    service_token: str | None,
    lookback_days: int,
) -> list[BenchRunPoint]:
    """Pull recent `capability.bench_run_completed` events from
    audit-gov's search endpoint and decode into BenchRunPoint."""
    base = (audit_gov_url or os.environ.get("AUDIT_GOV_URL", _DEFAULT_AUDIT_GOV_URL)).rstrip("/")
    token = service_token or os.environ.get("AUDIT_GOV_SERVICE_TOKEN", "")
    # audit-gov's z.string().datetime() accepts the ISO-8601 "Z"
    # suffix but rejects the "+00:00" Python default. Strip
    # microseconds for compactness; the lookback is days-scale so
    # sub-second precision is irrelevant.
    since = (
        (datetime.now(timezone.utc) - timedelta(days=lookback_days))
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    body = {
        "kinds": ["capability.bench_run_completed"],
        "sources": ["capability-harness"],
        "since": since,
        "limit": 200,
    }
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(  # noqa: S310 — known internal URL
        f"{base}/api/v1/audit/search",
        data=data,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"audit-gov search HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"audit-gov search transport error: {exc}") from exc

    items = payload.get("items") or []
    out: list[BenchRunPoint] = []
    for event in items:
        payload_dict = event.get("payload") or {}
        try:
            out.append(BenchRunPoint(
                created_at=str(event.get("created_at") or ""),
                model_alias=str(payload_dict.get("model_alias") or "(default)"),
                pass_rate=float(payload_dict.get("pass_rate") or 0.0),
                pass_count=int(payload_dict.get("pass_count") or 0),
                fail_count=int(payload_dict.get("fail_count") or 0),
                trace_id=str(event.get("trace_id") or ""),
            ))
        except (TypeError, ValueError):
            # Skip malformed events — the harness keeps adding good
            # data and the bad rows age out of the lookback window.
            continue
    return out


def _default_event_poster(url: str, body: dict, headers: dict, timeout: float) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")  # noqa: S310
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        text = resp.read().decode("utf-8", errors="replace")
        return json.loads(text) if text else {}


# ── CLI ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    """Tiny CLI for the cron entry. Exit code 0 = no regression,
    1 = regression(s) detected (+ alert(s) emitted)."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Detect capability-harness regressions and emit alerts.",
    )
    parser.add_argument(
        "--window-runs", type=int, default=_DEFAULT_WINDOW_RUNS,
        help=f"Trailing window size (default {_DEFAULT_WINDOW_RUNS} runs).",
    )
    parser.add_argument(
        "--threshold", type=float, default=_DEFAULT_THRESHOLD,
        help=f"Drop threshold as fraction (default {_DEFAULT_THRESHOLD} = 5pp).",
    )
    parser.add_argument(
        "--lookback-days", type=int, default=_DEFAULT_LOOKBACK_DAYS,
        help=f"How far back to fetch history (default {_DEFAULT_LOOKBACK_DAYS} days).",
    )
    parser.add_argument(
        "--audit-gov-url", default=None,
        help="Override audit-gov base URL.",
    )
    args = parser.parse_args(argv)

    findings = detect_regressions(
        window_runs=args.window_runs,
        threshold=args.threshold,
        lookback_days=args.lookback_days,
        audit_gov_url=args.audit_gov_url,
    )

    if not findings:
        print("no regressions detected")
        return 0

    for f in findings:
        print(
            f"REGRESSION: {f.model_alias} "
            f"pass_rate {f.baseline_pass_rate * 100:.1f}% → "
            f"{f.current_pass_rate * 100:.1f}% "
            f"(drop {f.drop * 100:.1f}pp, window={f.baseline_window_size})"
        )
        ok = emit_regression_alert(
            finding=f,
            audit_gov_url=args.audit_gov_url,
        )
        if not ok:
            print(f"  warning: failed to emit alert event for {f.model_alias}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
