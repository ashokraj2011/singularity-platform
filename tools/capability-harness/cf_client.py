"""Thin HTTP client for context-fabric's /api/v1/execute-governed-stage.

Kept in a separate module so unit tests can replace it without
monkey-patching the runner. Dependency-free (stdlib urllib) so
the harness has no httpx/requests requirement.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class GovernedStageResponse:
    """Decoded successful response from /api/v1/execute-governed-stage.

    Field names mirror the StageRunResult.to_dict() shape on the CF
    side so a one-to-one mapping is obvious. Extra fields the harness
    doesn't care about pass through in `raw` for forensic dumps."""

    success: bool
    stop_reason: str
    turn_count: int
    final_phase: str
    receipts_by_phase: dict[str, list[dict[str, Any]]]
    raw: dict[str, Any]


def execute_governed_stage(
    *,
    cf_url: str,
    stage_key: str,
    agent_role: str | None,
    goal: str,
    model_alias: str | None = None,
    max_turns: int | None = None,
    timeout_sec: float = 300.0,
    extra_vars: dict[str, Any] | None = None,
    _http_post: Any = None,  # injection seam for tests
) -> GovernedStageResponse:
    """POST to CF's governed-stage endpoint and decode the response.

    Raises:
      CapabilityHarnessHttpError on non-2xx or transport failure —
      caller turns that into a per-task "dispatch error" outcome
      rather than aborting the whole run.
    """
    url = cf_url.rstrip("/") + "/api/v1/execute-governed-stage"
    body: dict[str, Any] = {
        "stage_key": stage_key,
        "agent_role": agent_role,
        "vars": {
            "goal": goal,
            **(extra_vars or {}),
        },
        "run_context": {
            # capability-harness is the synthetic actor; CF uses this
            # in audit events so operators can grep for harness runs.
            "trace_id": "capability-harness",
            "actor_id": "capability-harness",
        },
    }
    if model_alias:
        body["model_alias"] = model_alias
    if max_turns:
        body["max_turns"] = max_turns

    poster = _http_post or _default_http_post
    raw = poster(url, body, timeout_sec)

    if not isinstance(raw, dict) or not raw.get("success"):
        raise CapabilityHarnessHttpError(
            f"CF returned non-success body: {str(raw)[:300]}"
        )
    data = raw.get("data") or {}
    if not isinstance(data, dict):
        raise CapabilityHarnessHttpError(
            f"CF returned non-object data block: {type(data).__name__}"
        )

    return GovernedStageResponse(
        success=True,
        stop_reason=str(data.get("stop_reason") or ""),
        turn_count=int(len(data.get("turns") or [])),
        final_phase=str(((data.get("final_state") or {}).get("current_phase")) or ""),
        receipts_by_phase=dict(((data.get("final_state") or {}).get("receipts")) or {}),
        raw=data,
    )


class CapabilityHarnessHttpError(RuntimeError):
    """Anything that prevents the harness from getting a usable
    GovernedStageResponse: network failure, 4xx/5xx, malformed body.
    Distinct from a task-level failure (the stage ran but scored
    poorly) so the runner can tally them separately."""


def _default_http_post(url: str, body: dict[str, Any], timeout_sec: float) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(  # noqa: S310 — known internal URL
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")[:500]
        raise CapabilityHarnessHttpError(
            f"HTTP {exc.code}: {body_text}"
        ) from exc
    except urllib.error.URLError as exc:
        raise CapabilityHarnessHttpError(f"transport error: {exc}") from exc
