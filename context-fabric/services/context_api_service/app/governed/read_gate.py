"""
M99 S3.3 — hard full-file-read gate.

Pre-M99 the large-file-read policy was advisory: loop.py emitted a
governed.large_file_read audit event but still handed the agent the full
content (soft enforcement). The spec wants full-file reads allowed only by
policy exception or a small-file threshold — i.e. a HARD gate.

This module is the pure decision function. loop.py calls it post-dispatch
(it needs the file's line count) and, on REFUSE, replaces the delivered
content with the refusal message instead of the file body.

The gate trips only when ALL of:
  * policy.context_policy.full_file_read_requires_justification is truthy
  * the read result exceeds large_file_threshold_lines (the small-file escape)
  * the read_file call carried no non-empty `justification` arg (the
    explicit-exception escape)

When full_file_read_requires_justification is falsy/absent (the default in
every seeded policy today) this is a strict no-op — behavior is unchanged
and the existing soft audit event still fires. So S3.3 ships dark at the
policy layer: an operator opts in per-stage by setting the policy field.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ReadGateDecision:
    refuse: bool
    reason: str | None = None
    line_count: int | None = None
    threshold: int | None = None


# read_file arg aliases the agent might use to justify a full read.
_JUSTIFICATION_KEYS = ("justification", "reason", "why", "rationale")


def _has_justification(args: dict[str, Any] | None) -> bool:
    if not isinstance(args, dict):
        return False
    for k in _JUSTIFICATION_KEYS:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return True
    return False


def evaluate_full_file_read_gate(
    *,
    tool_name: str,
    tool_success: bool,
    args: dict[str, Any] | None,
    line_count: int | None,
    context_policy: dict[str, Any] | None,
) -> ReadGateDecision:
    """Decide whether to refuse an oversized full-file read. Pure.

    Returns ReadGateDecision(refuse=False) for everything except a tripped
    gate — including: non-read tools, failed reads, missing/zero threshold,
    falsy policy flag, sub-threshold files, and reads carrying a
    justification. The caller acts only on refuse=True.
    """
    if tool_name != "read_file" or not tool_success:
        return ReadGateDecision(refuse=False)
    if not isinstance(context_policy, dict):
        return ReadGateDecision(refuse=False)
    if not context_policy.get("full_file_read_requires_justification"):
        return ReadGateDecision(refuse=False)
    threshold = context_policy.get("large_file_threshold_lines")
    if not isinstance(threshold, int) or threshold <= 0:
        # No threshold to measure against → can't gate; stay soft.
        return ReadGateDecision(refuse=False)
    if not isinstance(line_count, int) or line_count <= threshold:
        return ReadGateDecision(refuse=False, line_count=line_count, threshold=threshold)
    if _has_justification(args):
        # Explicit operator-sanctioned exception path.
        return ReadGateDecision(refuse=False, line_count=line_count, threshold=threshold)
    return ReadGateDecision(
        refuse=True,
        line_count=line_count,
        threshold=threshold,
        reason=(
            f"Full-file read refused: this file is {line_count} lines "
            f"(> the {threshold}-line policy threshold) and this stage's policy "
            "requires justification for full reads. Prefer get_ast_slice / "
            "find_symbol / grep to read only the region you need. If you "
            "genuinely need the whole file, re-issue read_file with a "
            "`justification` argument explaining why a targeted slice won't do."
        ),
    )


def refusal_result(decision: ReadGateDecision, path: str) -> dict[str, Any]:
    """The content envelope substituted for the file body on refuse.

    Shaped like a read_file result (content/path keys) so downstream
    history-rendering + masking treat it uniformly — the agent simply sees
    the refusal text where the file body would have been.
    """
    return {
        "path": path,
        "content": decision.reason or "Full-file read refused by policy.",
        "read_gate_refused": True,
        "line_count": decision.line_count,
        "threshold_lines": decision.threshold,
    }
