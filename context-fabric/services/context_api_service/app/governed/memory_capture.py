"""[P2 #25 — write slice] Capture a governed run's outcome as an ExecutionMemory
CANDIDATE so it feeds the long-term-memory promotion lifecycle.

The READ slice surfaces PROMOTED distilled memory back into future governed turns;
this WRITE slice closes the loop by recording each completed run's outcome as a
NOT_REVIEWED ExecutionMemory. The existing human/curator flow then reviews →
approves → promote()s it into DistilledMemory.

Design constraints:
  - Flag-gated: CF_CAPTURE_RUN_MEMORY (default OFF) — opt-in until verified live.
  - Best-effort: a failure NEVER blocks stage completion (logged + swallowed).
  - Auth: posts with the run's bearer (a valid IAM token agent-runtime verifies;
    agent-runtime is also lenient under AUTH_OPTIONAL in dev).
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from ..config import settings
from .env_config import bounded_float_env

log = logging.getLogger(__name__)

_HTTP_TIMEOUT = bounded_float_env(
    "CF_CAPTURE_RUN_MEMORY_TIMEOUT_SEC",
    default=5.0,
    min_value=1.0,
    max_value=300.0,
    logger=log,
)
_MAX_CONTENT_CHARS = 4000
# Only successful completions become memory candidates by default. Failures are
# noisy and rarely a reusable "lesson"; opt them in with CF_CAPTURE_RUN_MEMORY_STOP_REASONS.
_DEFAULT_STOP_REASONS = "FINALIZED"


def capture_enabled() -> bool:
    return os.environ.get("CF_CAPTURE_RUN_MEMORY", "").strip().lower() in ("1", "true", "yes", "on")


def _captured_stop_reasons() -> set[str]:
    raw = os.environ.get("CF_CAPTURE_RUN_MEMORY_STOP_REASONS", _DEFAULT_STOP_REASONS)
    return {s.strip().upper() for s in raw.split(",") if s.strip()}


def run_execution_id(run_context: dict[str, Any]) -> str | None:
    """The id that links this memory back to the run. Prefer the workflow
    instance; fall back through work-item / trace ids."""
    for key in (
        "instanceId", "workflowExecutionId", "workflow_execution_id",
        "work_item_id", "workItemId", "trace_id", "traceId",
    ):
        v = run_context.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def build_outcome_narrative(
    *, stage_key: str, agent_role: str | None, final_phase: str, stop_reason: str,
    totals: dict[str, Any] | None,
) -> str:
    """A compact, deterministic outcome summary — enough for a curator to judge
    whether it's worth promoting, without dumping the full transcript."""
    lines = [
        f"Stage `{stage_key}` ({agent_role or 'agent'}) outcome: {stop_reason}.",
        f"Final phase: {final_phase}.",
    ]
    t = totals or {}
    lines.append(
        f"Cost: {t.get('input_tokens', 0)} in / {t.get('output_tokens', 0)} out tokens, "
        f"{t.get('tool_calls', 0)} tool calls ({t.get('tools_refused', 0)} refused)."
    )
    return "\n".join(lines)[:_MAX_CONTENT_CHARS]


async def capture_run_outcome_memory(
    *, stage_key: str, agent_role: str | None, state: Any, result: Any,
    run_context: dict[str, Any] | None, bearer: str | None,
) -> None:
    """Best-effort store of the run outcome as an ExecutionMemory candidate.

    Never raises — any failure (disabled, no execution id, network, 4xx) logs and
    returns so stage completion is unaffected.
    """
    if not capture_enabled():
        return
    stop_reason = (getattr(result, "stop_reason", "") or "").upper()
    if stop_reason not in _captured_stop_reasons():
        return
    base = (settings.agent_runtime_url or "").rstrip("/")
    if not base:
        return
    rc = run_context if isinstance(run_context, dict) else {}
    execution_id = run_execution_id(rc)
    if not execution_id:
        log.debug("[memory-capture] no execution id in run_context; skipping")
        return

    try:
        final_phase = state.current_phase.value if state is not None and getattr(state, "current_phase", None) else "?"
    except Exception:  # pragma: no cover - defensive
        final_phase = "?"
    totals = result.to_dict().get("totals", {}) if result is not None else {}

    body: dict[str, Any] = {
        "workflowExecutionId": execution_id,
        "memoryType": "RUN_OUTCOME",
        "title": f"{stage_key}/{agent_role or 'agent'}: {stop_reason or 'COMPLETED'}"[:200],
        "content": build_outcome_narrative(
            stage_key=stage_key, agent_role=agent_role, final_phase=final_phase,
            stop_reason=stop_reason or "COMPLETED", totals=totals,
        ),
    }
    cap = rc.get("capability_id") or rc.get("capabilityId")
    if isinstance(cap, str) and cap.strip():
        body["capabilityId"] = cap.strip()
    tid = rc.get("trace_id") or rc.get("traceId")
    if isinstance(tid, str) and tid.strip():
        body["evidenceRefs"] = [f"trace:{tid.strip()}"]

    headers = {"content-type": "application/json"}
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.post(f"{base}/api/v1/memory/execution", headers=headers, json=body)
        if resp.status_code >= 400:
            log.warning("[memory-capture] agent-runtime %s: %s", resp.status_code, resp.text[:200])
        else:
            log.info("[memory-capture] stored run-outcome candidate for execution %s", execution_id)
    except Exception as exc:  # never block stage completion
        log.warning("[memory-capture] failed to store run-outcome memory: %s", exc)
