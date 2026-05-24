"""Publish capability-harness run results to audit-gov as events.

Each run emits exactly two event kinds:

  capability.bench_run_started — once per corpus run, with the
    corpus path + total task count + model. Lets operators see a
    bench run starting in the audit-gov live tail.

  capability.bench_task_completed — one per task, with the verdict,
    duration, per-oracle scores, and the stop_reason from CF. The
    rich payload is what the weekly cron (#117) will aggregate
    over to compute per-model pass-rate trends.

We deliberately do NOT emit one event per oracle (would be 3× the
volume for no extra information — the per-oracle scores ride in
the task_completed event's payload). And we don't emit the raw
agent_output — it can be megabytes of code, and the trace_id
linkage lets operators pull it from the per-run JSONL on disk if
they need forensics.

This module is import-time-free of any harness-internal types so
the publisher can be tested in isolation. The runner constructs
the payload dicts and hands them here.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


_DEFAULT_AUDIT_GOV_URL = "http://localhost:8500"
_DEFAULT_SOURCE_SERVICE = "capability-harness"


@dataclass(frozen=True)
class PublishResult:
    """Outcome of one publish attempt. Frozen so the runner can log
    the result without worrying about mutation."""

    success: bool
    status_code: int | None
    event_id: str | None
    error: str | None


def publish_run_started(
    *,
    trace_id: str,
    corpus_path: str,
    task_count: int,
    model_alias: str | None,
    audit_gov_url: str | None = None,
    service_token: str | None = None,
    _http_post: Any = None,
) -> PublishResult:
    """Emit `capability.bench_run_started` at the top of a corpus run."""
    return _post_event(
        kind="capability.bench_run_started",
        trace_id=trace_id,
        severity="info",
        payload={
            "corpus_path": corpus_path,
            "task_count": task_count,
            "model_alias": model_alias or "(default)",
        },
        audit_gov_url=audit_gov_url,
        service_token=service_token,
        _http_post=_http_post,
    )


def publish_task_completed(
    *,
    trace_id: str,
    task_id: str,
    passed: bool,
    duration_ms: int,
    stop_reason: str,
    turn_count: int,
    oracle_scores: list[dict[str, Any]],
    model_alias: str | None,
    dispatch_error: str | None = None,
    audit_gov_url: str | None = None,
    service_token: str | None = None,
    _http_post: Any = None,
) -> PublishResult:
    """Emit `capability.bench_task_completed` after each task scores.

    Severity climbs with badness:
      passed → "info"
      failed → "warn"
      dispatch error → "error" (something broke before scoring even ran)
    """
    if dispatch_error:
        severity = "error"
    elif not passed:
        severity = "warn"
    else:
        severity = "info"
    return _post_event(
        kind="capability.bench_task_completed",
        trace_id=trace_id,
        severity=severity,
        payload={
            "task_id": task_id,
            "passed": passed,
            "duration_ms": duration_ms,
            "stop_reason": stop_reason,
            "turn_count": turn_count,
            "oracle_scores": oracle_scores,
            "model_alias": model_alias or "(default)",
            "dispatch_error": dispatch_error,
        },
        audit_gov_url=audit_gov_url,
        service_token=service_token,
        _http_post=_http_post,
    )


def publish_run_completed(
    *,
    trace_id: str,
    pass_count: int,
    fail_count: int,
    pass_rate: float,
    duration_ms: int,
    model_alias: str | None,
    audit_gov_url: str | None = None,
    service_token: str | None = None,
    _http_post: Any = None,
) -> PublishResult:
    """Emit `capability.bench_run_completed` summarising the whole
    run. Useful for the weekly cron's "did the bench actually
    finish?" check, and as a join target for per-task events."""
    return _post_event(
        kind="capability.bench_run_completed",
        trace_id=trace_id,
        severity="info",
        payload={
            "pass_count": pass_count,
            "fail_count": fail_count,
            "pass_rate": pass_rate,
            "duration_ms": duration_ms,
            "model_alias": model_alias or "(default)",
        },
        audit_gov_url=audit_gov_url,
        service_token=service_token,
        _http_post=_http_post,
    )


# ── transport ─────────────────────────────────────────────────────────────


def _post_event(
    *,
    kind: str,
    trace_id: str,
    severity: str,
    payload: dict[str, Any],
    audit_gov_url: str | None,
    service_token: str | None,
    _http_post: Any = None,
) -> PublishResult:
    base = (audit_gov_url or os.environ.get("AUDIT_GOV_URL", _DEFAULT_AUDIT_GOV_URL)).rstrip("/")
    token = service_token or os.environ.get("AUDIT_GOV_SERVICE_TOKEN", "")
    url = f"{base}/api/v1/events"
    body = {
        "trace_id": trace_id,
        "source_service": _DEFAULT_SOURCE_SERVICE,
        "kind": kind,
        "severity": severity,
        "payload": payload,
    }
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"

    poster = _http_post or _default_http_post
    try:
        resp = poster(url, body, headers, 10.0)
    except Exception as exc:  # noqa: BLE001 — best-effort telemetry
        return PublishResult(
            success=False,
            status_code=None,
            event_id=None,
            error=str(exc),
        )
    return PublishResult(
        success=True,
        status_code=resp.get("status_code", 200),
        event_id=str(resp.get("id") or ""),
        error=None,
    )


def _default_http_post(url: str, body: dict[str, Any], headers: dict[str, str], timeout: float) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            body_text = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(body_text) if body_text else {}
            return {**parsed, "status_code": resp.status}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"audit-gov HTTP {exc.code}: {body_text}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"audit-gov transport error: {exc}") from exc
