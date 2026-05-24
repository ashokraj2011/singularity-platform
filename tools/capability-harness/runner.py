"""Capability harness runner — CLI + library entry point.

Usage:

    python tools/capability-harness/runner.py \\
        --corpus tools/capability-harness/corpora/mini-3.json

    python tools/capability-harness/runner.py \\
        --corpus tools/capability-harness/corpora/mini-3.json \\
        --task palindrome_function

    python tools/capability-harness/runner.py \\
        --corpus tools/capability-harness/corpora/mini-3.json \\
        --dry-run

Library:

    from runner import run_corpus
    result = run_corpus("corpora/mini-3.json", cf_url="http://localhost:8000")

Output: under `tools/capability-harness/results/<timestamp>/` writes
`run.jsonl` (one row per task) and `summary.md` (human-readable).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make this script runnable both as `python runner.py` (no package
# prefix) AND as `python -m tools.capability_harness.runner`. The
# directory contains a hyphen so we can't use the latter without a
# rename — adding the sibling files to sys.path is the simpler fix.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from cf_client import (  # noqa: E402 — sys.path tweak above
    CapabilityHarnessHttpError,
    GovernedStageResponse,
    execute_governed_stage,
)
from corpus import CorpusTask, load_corpus  # noqa: E402
from scoring import TaskScore, score_task  # noqa: E402


@dataclass
class TaskRunRecord:
    """One row of the results JSONL."""

    task_id: str
    started_at: str
    duration_ms: int
    dispatch_error: str | None
    stop_reason: str
    turn_count: int
    final_phase: str
    agent_output: str
    score: TaskScore | None
    raw_response: dict[str, Any] | None = field(default=None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "started_at": self.started_at,
            "duration_ms": self.duration_ms,
            "dispatch_error": self.dispatch_error,
            "stop_reason": self.stop_reason,
            "turn_count": self.turn_count,
            "final_phase": self.final_phase,
            "agent_output_preview": (self.agent_output or "")[:1500],
            "score": self.score.to_dict() if self.score else None,
        }


@dataclass
class CorpusRunResult:
    """Aggregate result for a full corpus run."""

    corpus_path: str
    started_at: str
    duration_ms: int
    model_alias: str | None
    dry_run: bool
    records: list[TaskRunRecord] = field(default_factory=list)

    @property
    def pass_count(self) -> int:
        return sum(1 for r in self.records if r.score and r.score.passed)

    @property
    def fail_count(self) -> int:
        return sum(
            1 for r in self.records
            if (r.score and not r.score.passed) or r.dispatch_error
        )

    @property
    def pass_rate(self) -> float:
        total = len(self.records)
        return (self.pass_count / total) if total else 0.0


# ── Library API ────────────────────────────────────────────────────────────


def run_corpus(
    corpus_path: str | Path,
    *,
    cf_url: str = "http://localhost:8000",
    judge_gateway_url: str | None = None,
    judge_model_alias: str | None = None,
    task_filter: str | None = None,
    model_alias: str | None = None,
    dry_run: bool = False,
    results_dir: str | Path | None = None,
) -> CorpusRunResult:
    """Run the harness end-to-end. See module docstring for CLI."""
    tasks = load_corpus(corpus_path)
    if task_filter:
        tasks = [t for t in tasks if t.task_id == task_filter]
        if not tasks:
            raise ValueError(f"no task in corpus matches task_id={task_filter!r}")

    started = time.monotonic()
    started_iso = datetime.now(timezone.utc).isoformat()
    result = CorpusRunResult(
        corpus_path=str(corpus_path),
        started_at=started_iso,
        duration_ms=0,
        model_alias=model_alias,
        dry_run=dry_run,
    )

    for task in tasks:
        record = _run_single_task(
            task=task,
            cf_url=cf_url,
            judge_gateway_url=judge_gateway_url,
            judge_model_alias=judge_model_alias,
            model_alias=model_alias,
            dry_run=dry_run,
        )
        result.records.append(record)
        # Stream stdout per task so a long run isn't silent.
        verdict = (
            "PASS" if record.score and record.score.passed
            else "DISPATCH_ERR" if record.dispatch_error
            else "FAIL"
        )
        print(
            f"[{verdict}] {task.task_id} "
            f"({record.duration_ms}ms, stop={record.stop_reason or 'n/a'})",
            flush=True,
        )

    result.duration_ms = int((time.monotonic() - started) * 1000)

    if results_dir is None:
        results_dir = _HERE / "results" / started_iso.replace(":", "-")
    _write_results(result, Path(results_dir))
    print(f"\nWrote results to {results_dir}", flush=True)
    print(
        f"pass={result.pass_count} fail={result.fail_count} "
        f"rate={result.pass_rate * 100:.1f}%",
        flush=True,
    )
    return result


def _run_single_task(
    *,
    task: CorpusTask,
    cf_url: str,
    judge_gateway_url: str | None,
    judge_model_alias: str | None,
    model_alias: str | None,
    dry_run: bool,
) -> TaskRunRecord:
    """Drive one task: dispatch (or use sample_response), score, return
    the row. Errors get captured on the record rather than thrown so
    one bad task doesn't poison the whole corpus run."""
    started = time.monotonic()
    started_iso = datetime.now(timezone.utc).isoformat()

    if dry_run:
        if not task.sample_response:
            return TaskRunRecord(
                task_id=task.task_id,
                started_at=started_iso,
                duration_ms=int((time.monotonic() - started) * 1000),
                dispatch_error="dry-run requested but task has no sample_response",
                stop_reason="",
                turn_count=0,
                final_phase="",
                agent_output="",
                score=None,
            )
        response_data = task.sample_response
        stop_reason = str(response_data.get("stop_reason") or "DRYRUN")
        turn_count = int(len(response_data.get("turns") or []))
        final_phase = str(((response_data.get("final_state") or {}).get("current_phase")) or "")
    else:
        try:
            api_resp = execute_governed_stage(
                cf_url=cf_url,
                stage_key=task.stage_key,
                agent_role=task.agent_role,
                goal=task.goal,
                model_alias=model_alias or task.model_alias,
                max_turns=task.max_turns,
            )
        except CapabilityHarnessHttpError as exc:
            return TaskRunRecord(
                task_id=task.task_id,
                started_at=started_iso,
                duration_ms=int((time.monotonic() - started) * 1000),
                dispatch_error=str(exc),
                stop_reason="",
                turn_count=0,
                final_phase="",
                agent_output="",
                score=None,
            )
        response_data = api_resp.raw
        stop_reason = api_resp.stop_reason
        turn_count = api_resp.turn_count
        final_phase = api_resp.final_phase

    agent_output = _extract_agent_output(response_data)
    task_score = score_task(
        task=task,
        agent_output=agent_output,
        judge_gateway_url=judge_gateway_url,
        judge_model_alias=judge_model_alias,
        skip_judge=dry_run,
    )

    return TaskRunRecord(
        task_id=task.task_id,
        started_at=started_iso,
        duration_ms=int((time.monotonic() - started) * 1000),
        dispatch_error=None,
        stop_reason=stop_reason,
        turn_count=turn_count,
        final_phase=final_phase,
        agent_output=agent_output,
        score=task_score,
        raw_response=response_data,
    )


def _extract_agent_output(response_data: dict[str, Any]) -> str:
    """Pull the agent's deliverable out of the StageRunResult shape.

    For coding stages the deliverable lives in the FINALIZE phase's
    receipts (or the last receipt overall). For dry-runs we accept
    a top-level `agent_output` field on the sample_response so
    corpus authors can pin it directly without faking the full
    StageRunResult structure.
    """
    # Dry-run shortcut.
    direct = response_data.get("agent_output")
    if isinstance(direct, str):
        return direct

    # Real-run extraction: walk receipts in order, find the most
    # finalized one. Receipts are keyed by phase name; the last
    # phase's receipt is the deliverable.
    final_state = response_data.get("final_state") or {}
    receipts = final_state.get("receipts") or {}
    for phase in ("FINALIZE", "SELF_REVIEW", "ACT", "VERIFY", "PLAN"):
        bucket = receipts.get(phase) or []
        if bucket:
            last = bucket[-1]
            # Common shape: receipt payload has `payload` dict; for
            # PRODUCT_OWNER stages we put narrative under story_brief.
            payload = last.get("payload") or last
            if isinstance(payload, dict):
                # Prefer a literal `output` / `narrative` / `story_brief`
                # / `summary` field when present.
                for key in ("output", "narrative", "story_brief", "summary"):
                    if isinstance(payload.get(key), str):
                        return payload[key]
                return json.dumps(payload, indent=2)
            if isinstance(payload, str):
                return payload
    return ""


# ── Results writer ─────────────────────────────────────────────────────────


def _write_results(result: CorpusRunResult, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = out_dir / "run.jsonl"
    with jsonl_path.open("w") as fh:
        for rec in result.records:
            fh.write(json.dumps(rec.to_dict()) + "\n")
    (out_dir / "summary.md").write_text(_render_summary(result))


def _render_summary(result: CorpusRunResult) -> str:
    lines: list[str] = []
    lines.append(f"# Capability harness run — {result.started_at}")
    lines.append("")
    lines.append(f"- Corpus: `{result.corpus_path}`")
    lines.append(f"- Model alias: `{result.model_alias or '(default)'}`")
    lines.append(f"- Dry run: {result.dry_run}")
    lines.append(f"- Total duration: {result.duration_ms}ms")
    lines.append("")
    lines.append(
        f"**Pass rate: {result.pass_count}/{len(result.records)} "
        f"({result.pass_rate * 100:.1f}%)** "
        f"— {result.fail_count} fail/error"
    )
    lines.append("")
    lines.append("| task | verdict | stop | turns | dur(ms) | oracle scores |")
    lines.append("|---|---|---|---|---|---|")
    for rec in result.records:
        verdict = (
            "✅ PASS" if rec.score and rec.score.passed
            else "❌ DISPATCH_ERR" if rec.dispatch_error
            else "❌ FAIL"
        )
        oracle_summary = (
            ", ".join(
                f"{o.name}={'✓' if o.passed else '✗'}({o.score:.2f})"
                for o in rec.score.oracles
            )
            if rec.score else "—"
        )
        lines.append(
            f"| `{rec.task_id}` | {verdict} | {rec.stop_reason or '—'} | "
            f"{rec.turn_count} | {rec.duration_ms} | {oracle_summary} |"
        )
    return "\n".join(lines) + "\n"


# ── CLI ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="M74 Phase 4A capability harness runner.")
    parser.add_argument("--corpus", required=True, help="Path to the corpus JSON file.")
    parser.add_argument(
        "--cf-url",
        default="http://localhost:8000",
        help="Base URL of context-fabric (default: http://localhost:8000).",
    )
    parser.add_argument(
        "--judge-gateway-url",
        default=None,
        help="Override LLM gateway URL for the judge (defaults to $LLM_GATEWAY_URL).",
    )
    parser.add_argument(
        "--judge-model-alias",
        default=None,
        help="Override the judge model alias (defaults to $JUDGE_MODEL_ALIAS).",
    )
    parser.add_argument(
        "--task",
        default=None,
        help="Run a single task by task_id.",
    )
    parser.add_argument(
        "--model-alias",
        default=None,
        help="Override the model alias for governed-stage execution.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip CF + gateway calls; use sample_response from corpus.",
    )
    parser.add_argument(
        "--results-dir",
        default=None,
        help="Output directory (default: tools/capability-harness/results/<timestamp>/).",
    )
    args = parser.parse_args(argv)

    try:
        result = run_corpus(
            args.corpus,
            cf_url=args.cf_url,
            judge_gateway_url=args.judge_gateway_url,
            judge_model_alias=args.judge_model_alias,
            task_filter=args.task,
            model_alias=args.model_alias,
            dry_run=args.dry_run,
            results_dir=args.results_dir,
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    return 0 if result.fail_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
