"""
M74 Phase 1B — path-coverage check.

Pure functions (no I/O, no async) that compare a PlanReceipt's
declared target_files against an EditReceipt's actual edits + the
agent's explicit skipped_targets. Lives in its own module so it can
be tested without spinning up the whole governed loop.

The loop's responsibility is just to call ``check_path_coverage(...)``
when transitioning ACT → VERIFY. If it returns a CoverageGap, refuse
the advance.

Spec intent: restore the structural check invoke.ts had via
finish_gate_premature. An agent that plans to edit [A, B, C] but only
touches A must either edit B and C, or explicitly declare them
skipped with a reason. The current schema is permissive in both
directions (edits[] and target_files[] are independent lists) so the
check has to live at the orchestrator layer where both receipts are
in scope.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _normalise(path: str) -> str:
    """Compare paths case-sensitively but strip surrounding whitespace
    and leading ``./``. Aligned with how mcp-server's sandbox paths
    are normalised before AST indexing.

    Fix (review issue #4, 2026-05-23) — convert Windows backslashes
    to forward slashes so a plan that says ``src/foo.py`` matches
    an edit emitted as ``src\\foo.py`` (or vice versa). Without this
    a Windows operator or repo with native backslash paths triggers
    false-positive PHASE_COVERAGE_GAP blocks even when the right
    files were edited.
    """
    p = (path or "").strip()
    # Normalise Windows-style backslashes first so ".\\foo" → "./foo"
    # → "foo" via the strip loop below.
    p = p.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p


def _path_set(items: list[dict[str, Any]] | list[str], key: str | None = None) -> set[str]:
    """Pull a normalised set of file paths out of either a list of
    dicts (with ``key`` naming the path field) or a list of bare
    strings. Defensive — drops empty entries silently rather than
    raising, since the validator already enforced presence."""
    out: set[str] = set()
    for entry in items or ():
        if key is not None:
            if not isinstance(entry, dict):
                continue
            raw = entry.get(key)
        else:
            raw = entry
        if not isinstance(raw, str):
            continue
        norm = _normalise(raw)
        if norm:
            out.add(norm)
    return out


@dataclass(frozen=True)
class CoverageGap:
    """Returned by ``check_path_coverage`` when the EditReceipt does not
    cover the PlanReceipt's targets and the agent didn't declare them
    skipped. ``uncovered`` is the list the agent neither edited nor
    explicitly skipped."""
    uncovered: tuple[str, ...]

    def as_error_payload(self) -> dict[str, Any]:
        return {
            "error_code": "PHASE_COVERAGE_GAP",
            "phase": "ACT",
            "reason": (
                "EditReceipt does not cover all PlanReceipt.target_files and no "
                "skipped_targets entry was provided for the uncovered paths. "
                "Either edit them, or add a SkippedTarget with a reason."
            ),
            "uncovered_targets": list(self.uncovered),
        }


def check_path_coverage(
    plan_receipt: dict[str, Any] | None,
    edit_receipt: dict[str, Any],
) -> CoverageGap | None:
    """Return None when coverage is OK; CoverageGap when not.

    Coverage rules:
      * If there's no prior PlanReceipt (None or empty target_files),
        coverage is vacuously satisfied — the agent had no plan to
        contradict.
      * Every PlanReceipt.target_files entry must appear in EITHER
        EditReceipt.edits[].file OR EditReceipt.skipped_targets[].file.
        Path comparison is normalised but case-sensitive.
      * Over-coverage is fine — edits[] may include files NOT in the
        plan (the agent legitimately discovered a needed change). Only
        UNDER-coverage is refused.
      * If a target appears in both edits[] and skipped_targets[], the
        edit wins (i.e. the target is covered). The skipped_targets
        entry is treated as a soft declaration the actual edit
        superseded.

    The receipts arrive as dicts (Pydantic .model_dump shape), not the
    Pydantic models themselves, so this helper has zero dependency on
    receipts.py and can be unit-tested without the model overhead.
    """
    if not isinstance(plan_receipt, dict):
        return None
    targets = _path_set(plan_receipt.get("target_files") or [], key=None)
    if not targets:
        return None

    edited = _path_set(edit_receipt.get("edits") or [], key="file")
    skipped = _path_set(edit_receipt.get("skipped_targets") or [], key="file")
    covered = edited | skipped

    uncovered = sorted(targets - covered)
    if not uncovered:
        return None
    return CoverageGap(uncovered=tuple(uncovered))
