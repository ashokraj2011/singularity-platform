"""End-to-end tests for the runner — dry-run mode (no network), the
results writer, and the CLI's exit code contract.

We deliberately do NOT spin up CF in unit tests. The cf_client module
is tested via dependency injection at the unit level; the runner is
exercised in dry-run mode where it uses sample_response from the
corpus and skips both CF and the LLM gateway.
"""
from __future__ import annotations

import json
from pathlib import Path

from runner import _extract_agent_output, _render_summary, run_corpus, main


# ── _extract_agent_output ──────────────────────────────────────────────────


def test_extract_agent_output_dry_run_shortcut() -> None:
    """Dry-run shortcut: sample_response has a literal `agent_output`
    string. Returned as-is."""
    out = _extract_agent_output({"agent_output": "def f(): pass"})
    assert out == "def f(): pass"


def test_extract_agent_output_from_finalize_receipt() -> None:
    """Real-run extraction: walk receipts to find the FINALIZE bucket
    and pull its payload."""
    out = _extract_agent_output({
        "final_state": {
            "receipts": {
                "PLAN": [{"payload": {"story_brief": "plan text"}}],
                "FINALIZE": [{"payload": {"output": "final answer"}}],
            }
        }
    })
    assert out == "final answer"


def test_extract_agent_output_prefers_later_phase() -> None:
    """When multiple phases have receipts, the runner picks the most
    final one (FINALIZE > SELF_REVIEW > ACT > VERIFY > PLAN)."""
    out = _extract_agent_output({
        "final_state": {
            "receipts": {
                "PLAN": [{"payload": {"output": "should NOT be picked"}}],
                "SELF_REVIEW": [{"payload": {"output": "this one"}}],
            }
        }
    })
    assert out == "this one"


def test_extract_agent_output_dumps_json_when_no_string_key() -> None:
    """No `output`/`narrative`/`story_brief`/`summary` field: fall
    back to a JSON dump so the scoring oracles still get *something*
    to look at."""
    out = _extract_agent_output({
        "final_state": {
            "receipts": {
                "PLAN": [{"payload": {"target_files": ["foo.py"], "risk_level": "low"}}]
            }
        }
    })
    assert '"target_files"' in out
    assert '"risk_level"' in out


def test_extract_agent_output_empty_when_no_receipts() -> None:
    """No receipts → empty string. Scoring oracles handle this case
    (diff oracle returns 'agent produced no output')."""
    assert _extract_agent_output({}) == ""
    assert _extract_agent_output({"final_state": {"receipts": {}}}) == ""


# ── run_corpus (dry-run end-to-end) ─────────────────────────────────────────


def _shipped_mini_corpus() -> str:
    return str(Path(__file__).resolve().parents[1] / "corpora" / "mini-3.json")


def test_run_corpus_dry_run_against_shipped_mini(tmp_path: Path) -> None:
    """Smoke: dry-run the shipped corpus end to end. No network,
    sample_response feeds the scorer, results written to tmp_path."""
    result = run_corpus(
        _shipped_mini_corpus(),
        results_dir=tmp_path,
        dry_run=True,
    )
    assert len(result.records) == 3
    # Every record should have a score; no dispatch errors in dry-run.
    for rec in result.records:
        assert rec.dispatch_error is None
        assert rec.score is not None
        assert rec.stop_reason == "FINALIZED"

    # Results files exist + are well-formed.
    assert (tmp_path / "run.jsonl").is_file()
    assert (tmp_path / "summary.md").is_file()
    rows = (tmp_path / "run.jsonl").read_text().strip().splitlines()
    assert len(rows) == 3
    for row in rows:
        json.loads(row)  # parses


def test_run_corpus_task_filter(tmp_path: Path) -> None:
    """--task flag should narrow to a single task. Useful for
    iterating on one corpus entry without re-running the whole set."""
    result = run_corpus(
        _shipped_mini_corpus(),
        results_dir=tmp_path,
        dry_run=True,
        task_filter="palindrome_function",
    )
    assert len(result.records) == 1
    assert result.records[0].task_id == "palindrome_function"


def test_run_corpus_unknown_task_filter_raises(tmp_path: Path) -> None:
    """Filtering to a non-existent task should error loudly so the
    operator notices the typo before kicking off a long run."""
    import pytest

    with pytest.raises(ValueError, match="no task in corpus matches"):
        run_corpus(
            _shipped_mini_corpus(),
            results_dir=tmp_path,
            dry_run=True,
            task_filter="nonexistent",
        )


def test_run_corpus_dry_run_without_sample_response_records_dispatch_error(
    tmp_path: Path,
) -> None:
    """If a corpus entry lacks sample_response and the runner is in
    dry-run mode, the row should record a dispatch_error rather than
    crashing — runner robustness over batch loss."""
    corpus_path = tmp_path / "c.json"
    corpus_path.write_text(json.dumps([
        {
            "task_id": "no_sample",
            "goal": "g",
            "stage_key": "loop.stage.develop",
            "agent_role": "DEVELOPER",
            "rubric": "r",
            "reference_patch": "p",
        },
    ]))
    out_dir = tmp_path / "out"
    result = run_corpus(str(corpus_path), results_dir=out_dir, dry_run=True)
    assert len(result.records) == 1
    rec = result.records[0]
    assert rec.dispatch_error is not None
    assert "sample_response" in rec.dispatch_error


# ── _render_summary ────────────────────────────────────────────────────────


def test_render_summary_includes_pass_rate(tmp_path: Path) -> None:
    result = run_corpus(_shipped_mini_corpus(), results_dir=tmp_path, dry_run=True)
    md = _render_summary(result)
    assert "Capability harness run" in md
    assert "Pass rate:" in md
    # Each task gets a row.
    for rec in result.records:
        assert f"`{rec.task_id}`" in md


# ── CLI ────────────────────────────────────────────────────────────────────


def test_cli_returns_exit_code_2_on_bad_corpus(tmp_path: Path) -> None:
    """CLI maps validation errors to exit 2 (sysexits.h:EX_USAGE
    convention) so operators can distinguish corpus problems from
    test failures (exit 1) and successful runs (exit 0)."""
    bad_path = tmp_path / "missing.json"
    rc = main(["--corpus", str(bad_path), "--dry-run", "--results-dir", str(tmp_path / "out")])
    assert rc == 2


def test_cli_returns_exit_code_1_when_any_task_fails(tmp_path: Path) -> None:
    """In Slice 1, every dry-run task has tests_pass stubbed-false, so
    the majority rule (2 of 3) requires BOTH diff and judge to pass.
    With skip_judge=True (auto-enabled in dry-run) judge contributes
    nothing, so all dry-run tasks fail the majority → exit 1."""
    out_dir = tmp_path / "out"
    rc = main([
        "--corpus", _shipped_mini_corpus(),
        "--dry-run",
        "--results-dir", str(out_dir),
    ])
    assert rc == 1  # all 3 tasks fail majority in dry-run
