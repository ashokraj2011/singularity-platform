"""Tests for the three review-driven gates added to governed/loop.py:

  • #2 EditReceipt provenance binding (file → backing code_change_id)
  • #4 Server-side cap on per-tool result size
  • #6 VERIFY → SELF_REVIEW gated on status='passed'

These exercise the pure helpers (_extract_code_changes,
_check_edit_receipt_provenance, _truncate_oversize_strings) in
isolation. End-to-end tests live in test_governed_loop.py — async
tests there can't run without pytest-asyncio so we keep these
sync-only and pin the building blocks.
"""
from __future__ import annotations

import pytest

from context_api_service.app.governed.loop import (
    _MUTATING_TOOLS,
    _check_edit_receipt_provenance,
    _extract_code_changes,
    _normalise_change_path,
    _truncate_oversize_strings,
)
from context_api_service.app.governed.phase_state import PhaseState


# ── #2 — _extract_code_changes ──────────────────────────────────────────────


def test_extract_returns_empty_for_non_mutating_tool() -> None:
    """read_file is in the allowlist but doesn't mutate — no
    code_change should be claimed."""
    assert _extract_code_changes(
        tool_name="read_file",
        result={"code_change_id": "spurious", "file": "x.py"},
        tool_success=True,
    ) == []


def test_extract_returns_empty_when_tool_failed() -> None:
    """A tool that ran but reported tool_success=False didn't actually
    edit anything. Don't credit it with a code_change."""
    assert _extract_code_changes(
        tool_name="apply_patch",
        result={"code_change_id": "cc-1", "file": "x.py"},
        tool_success=False,
    ) == []


def test_extract_returns_empty_when_no_change_id_and_no_invocation_id() -> None:
    """No change_id AND no tool_invocation_id fallback means we can't
    bind. Returning [] is correct — the EditReceipt validator will
    reject the file."""
    assert _extract_code_changes(
        tool_name="apply_patch",
        result={"file": "x.py"},
        tool_success=True,
        # tool_invocation_id intentionally omitted
    ) == []


def test_extract_falls_back_to_tool_invocation_id_when_no_change_id() -> None:
    """(2026-05-25) mcp-server's mutating tools (apply_patch,
    replace_text, write_file) emit `paths_touched` but NO
    `code_change_id`. The dispatch's invocation id ties the EditReceipt
    claim back to the audit-gov tool_dispatched event just as well —
    fall back to it instead of falsely flagging the edit as unbacked.
    """
    out = _extract_code_changes(
        tool_name="replace_text",
        result={"file": "src/foo.py", "kind": "code_change"},
        tool_success=True,
        tool_invocation_id="inv-abc123",
    )
    assert out == [("src/foo.py", "inv-abc123")]


def test_extract_handles_mcp_server_paths_touched_shape() -> None:
    """The exact shape mcp-server's replace_text/apply_patch/write_file
    return today: `paths_touched: [path]` plus diff/patch fields, no
    code_change_id. Verified by inspecting mcp-audit.jsonl on a
    successful develop attempt — the audit shows this output shape
    verbatim. The old extractor returned [] because it only knew about
    `files`/`changed_files` keys, never `paths_touched`. That made
    every legitimate mutation look unbacked.
    """
    # Exact shape pulled from /workspace/.singularity/mcp-audit.jsonl
    # on a real successful replace_text call (2026-05-25 develop run).
    result = {
        "kind": "code_change",
        "paths_touched": ["src/test/java/org/example/rules/RuleEngineServiceTest.java"],
        "diff": "diff --git a/... +new content",
        "patch": "...",
        "lines_added": 12,
        "lines_removed": 0,
    }
    out = _extract_code_changes(
        tool_name="replace_text",
        result=result,
        tool_success=True,
        tool_invocation_id="da1abe62-ed7b-447b-b7b0-e933c2ec233b",
    )
    assert out == [
        ("src/test/java/org/example/rules/RuleEngineServiceTest.java",
         "da1abe62-ed7b-447b-b7b0-e933c2ec233b"),
    ]


def test_extract_accepts_paths_touched_with_multiple_files() -> None:
    """apply_patch can touch multiple files in one call; mcp-server
    reports them all in a single `paths_touched` list."""
    out = _extract_code_changes(
        tool_name="apply_patch",
        result={
            "kind": "code_change",
            "paths_touched": ["src/a.py", "src/b.py", "src/c.py"],
            "diff": "...",
        },
        tool_success=True,
        tool_invocation_id="inv-batch",
    )
    assert sorted(out) == [
        ("src/a.py", "inv-batch"),
        ("src/b.py", "inv-batch"),
        ("src/c.py", "inv-batch"),
    ]


def test_extract_explicit_change_id_wins_over_invocation_id() -> None:
    """When a tool DOES emit a code_change_id, prefer it over the
    fallback. Future-proofs the fix for tools that have their own
    stable change-id mints (e.g. a git-commit-based change ID)."""
    out = _extract_code_changes(
        tool_name="apply_patch",
        result={
            "code_change_id": "real-cc-xyz",
            "paths_touched": ["src/foo.py"],
        },
        tool_success=True,
        tool_invocation_id="inv-fallback",
    )
    assert out == [("src/foo.py", "real-cc-xyz")]


def test_extract_dedupes_paths_across_batch_and_single_shapes() -> None:
    """If a tool somehow emits a path in both `paths_touched` AND
    single `file`, we should record the file once, not twice. The
    EditReceipt-provenance check is set-based so duplicates wouldn't
    cause incorrectness — but they'd inflate state.produced_code_changes
    and clutter audit-gov correlation queries."""
    out = _extract_code_changes(
        tool_name="apply_patch",
        result={
            "code_change_id": "cc-dup",
            "paths_touched": ["src/foo.py"],
            "file": "src/foo.py",
        },
        tool_success=True,
    )
    assert out == [("src/foo.py", "cc-dup")]


def test_extract_handles_all_change_id_aliases() -> None:
    """Aliases mirror the orchestrator.ts:codeChangeIds extraction."""
    for alias in ("code_change_id", "codeChangeId", "changeId", "change_id"):
        result = {alias: "cc-aliased", "file": "x.py"}
        out = _extract_code_changes(
            tool_name="apply_patch", result=result, tool_success=True,
        )
        assert out == [("x.py", "cc-aliased")]


def test_extract_handles_all_file_aliases() -> None:
    for file_key in ("file", "path", "file_path", "target_file"):
        result = {"code_change_id": "cc-1", file_key: "src/foo.py"}
        out = _extract_code_changes(
            tool_name="replace_text", result=result, tool_success=True,
        )
        assert out == [("src/foo.py", "cc-1")]


def test_extract_handles_batch_files() -> None:
    """Batch tools like apply_patch may touch multiple files in one
    call. Pick them all up via the `files` / `changed_files` keys."""
    result = {
        "code_change_id": "cc-batch",
        "files": ["src/a.py", "src/b.py", "src/c.py"],
    }
    out = _extract_code_changes(
        tool_name="apply_patch", result=result, tool_success=True,
    )
    assert sorted(out) == [
        ("src/a.py", "cc-batch"),
        ("src/b.py", "cc-batch"),
        ("src/c.py", "cc-batch"),
    ]


def test_extract_normalises_windows_paths() -> None:
    """The path normaliser flips backslashes — must match what
    path_coverage.py uses so the provenance set comparison
    succeeds against an EditReceipt that uses the other form."""
    out = _extract_code_changes(
        tool_name="apply_patch",
        result={"code_change_id": "cc-win", "file": "src\\app\\main.py"},
        tool_success=True,
    )
    assert out == [("src/app/main.py", "cc-win")]


def test_mutating_tools_set_matches_edit_type_literal() -> None:
    """The frozenset in loop.py must stay aligned with EditEntry's
    edit_type Literal in receipts.py. If someone adds a new mutating
    tool, both layers should know about it."""
    # EditEntry.edit_type allows these (from receipts.py:115). Each
    # corresponds to a tool the agent dispatches; the dispatch maps
    # 1:1 to the tool name on the wire.
    from context_api_service.app.governed.receipts import EditEntry
    # Pydantic field's `annotation` exposes the Literal type.
    edit_types = EditEntry.model_fields["edit_type"].annotation
    # `Literal[...]` exposes args via __args__.
    declared_edit_types = set(getattr(edit_types, "__args__", ()))
    # finish_work_branch isn't an edit_type per se — it's a "wrap up"
    # tool that produces a code_change_id (the final commit). Other
    # than that the sets should match.
    expected_edit_tools = declared_edit_types - {"replace_range"}  # rare; same shape
    # The mutating-tools set is a superset (adds finish_work_branch).
    assert expected_edit_tools.issubset(_MUTATING_TOOLS), (
        f"EditEntry.edit_type has {declared_edit_types} but loop._MUTATING_TOOLS "
        f"is {_MUTATING_TOOLS}. Add the missing tool to _MUTATING_TOOLS or "
        "the receipt validator will reject the file as unbacked."
    )


# ── #2 — _check_edit_receipt_provenance ─────────────────────────────────────


def test_provenance_check_passes_when_every_file_backed() -> None:
    receipt = {
        "edits": [
            {"file": "src/a.py", "edit_type": "apply_patch", "reason": "x"},
            {"file": "src/b.py", "edit_type": "replace_text", "reason": "y"},
        ],
    }
    produced = {"src/a.py": ["cc-1"], "src/b.py": ["cc-2"]}
    assert _check_edit_receipt_provenance(
        receipt=receipt, produced_changes=produced,
    ) == []


def test_provenance_check_flags_unbacked_files() -> None:
    """REGRESSION GUARD — closes the self-declared-receipt loophole."""
    receipt = {
        "edits": [
            {"file": "src/a.py", "edit_type": "apply_patch", "reason": "x"},
            {"file": "src/never_touched.py", "edit_type": "apply_patch", "reason": "lie"},
        ],
    }
    produced = {"src/a.py": ["cc-1"]}
    unbacked = _check_edit_receipt_provenance(
        receipt=receipt, produced_changes=produced,
    )
    assert unbacked == ["src/never_touched.py"]


def test_provenance_normalises_paths_before_compare() -> None:
    """Receipt uses backslashes; produced map uses forward slashes
    (because _extract normalises). Comparison must canonicalise both
    sides — otherwise the agent escapes the gate by flipping slashes."""
    receipt = {"edits": [{"file": "src\\foo.py", "edit_type": "apply_patch", "reason": "x"}]}
    produced = {"src/foo.py": ["cc-1"]}
    assert _check_edit_receipt_provenance(
        receipt=receipt, produced_changes=produced,
    ) == []


def test_provenance_check_ignores_empty_change_id_list() -> None:
    """A file key with an empty list isn't really backed. Pin that
    we don't treat that as evidence."""
    receipt = {"edits": [{"file": "src/x.py", "edit_type": "apply_patch", "reason": "x"}]}
    produced = {"src/x.py": []}
    assert _check_edit_receipt_provenance(
        receipt=receipt, produced_changes=produced,
    ) == ["src/x.py"]


def test_provenance_check_skips_malformed_entries() -> None:
    """Defensive: a receipt that wedges in a non-dict entry shouldn't
    crash the gate. Skip it and continue checking the rest."""
    receipt = {
        "edits": [
            {"file": "src/a.py", "edit_type": "apply_patch", "reason": "x"},
            "not a dict",
            {"no_file_key": True},
        ],
    }
    produced = {"src/a.py": ["cc-1"]}
    assert _check_edit_receipt_provenance(
        receipt=receipt, produced_changes=produced,
    ) == []


def test_provenance_path_canonical_form_matches_path_coverage() -> None:
    """The normaliser must agree with path_coverage._normalise so the
    two gates can't disagree about whether `./src/a.py`, `src\\a.py`,
    and `src/a.py` are the same file."""
    from context_api_service.app.governed.path_coverage import _normalise as pc_normalise
    for raw in ("src/a.py", "./src/a.py", "src\\a.py", "  src/a.py  "):
        assert _normalise_change_path(raw) == pc_normalise(raw), (
            f"_normalise_change_path and path_coverage._normalise diverge on {raw!r}"
        )


# ── PhaseState round-trip with produced_code_changes ────────────────────────


def test_phase_state_round_trip_preserves_produced_code_changes() -> None:
    """pause/resume must not lose the provenance trail. Without this
    a long-running stage that pauses for human approval would lose
    its receipt-binding evidence and the next turn's EditReceipt
    would be unbacked."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    # PhaseState is frozen — build a new one with the field set.
    from dataclasses import replace
    state = replace(state, produced_code_changes={
        "src/a.py": ["cc-1", "cc-2"],
        "src/b.py": ["cc-3"],
    })
    payload = state.to_dict()
    restored = PhaseState.from_dict(payload)
    assert restored.produced_code_changes == state.produced_code_changes


def test_phase_state_from_dict_defaults_produced_code_changes() -> None:
    """Pre-fix state rows don't have the key. Rehydrate without
    explosion (empty dict, not KeyError)."""
    payload = {
        "stage_key": "x", "agent_role": None, "current_phase": "PLAN",
        "repair_attempts": 0, "plan_rewinds": 0, "receipts": {},
        "history": [], "approval_pending": False, "pii_token_map": {},
    }
    state = PhaseState.from_dict(payload)
    assert state.produced_code_changes == {}


# ── #4 — _truncate_oversize_strings ─────────────────────────────────────────


def test_truncate_leaves_short_strings_alone() -> None:
    v, n = _truncate_oversize_strings("short", max_chars=100)
    assert v == "short"
    assert n == 0


def test_truncate_replaces_long_string_with_marker() -> None:
    v, n = _truncate_oversize_strings("a" * 1000, max_chars=100)
    assert n == 900
    assert "[truncated 900 chars by policy]" in v
    assert len(v) <= 100  # the marker eats from the budget


def test_truncate_walks_dicts() -> None:
    blob = {
        "file": "x.py",
        "content": "z" * 500,
        "meta": {"summary": "y" * 600},
    }
    v, n = _truncate_oversize_strings(blob, max_chars=50)
    assert n > 0
    # Structure preserved.
    assert v["file"] == "x.py"
    assert "[truncated" in v["content"]
    assert "[truncated" in v["meta"]["summary"]


def test_truncate_walks_lists() -> None:
    """Pretty common shape: tool returns `{lines: [...]}` for a file
    read. Each line must be truncated independently if oversize."""
    v, n = _truncate_oversize_strings(["x" * 200, "ok", "y" * 300], max_chars=50)
    assert n > 0
    assert isinstance(v, list)
    assert "[truncated" in v[0]
    assert v[1] == "ok"
    assert "[truncated" in v[2]


def test_truncate_preserves_non_string_leaves() -> None:
    """Int / bool / None / float leaves pass through. Without this,
    the walk would crash on any tool returning numeric counts."""
    blob = {"exit_code": 0, "passed": True, "rate": 0.95, "missing": None}
    v, n = _truncate_oversize_strings(blob, max_chars=100)
    assert n == 0
    assert v == blob


def test_truncate_returns_zero_bytes_when_nothing_truncated() -> None:
    """Caller relies on the 0-bytes sentinel to skip the audit event
    — otherwise every short-string call would emit noise."""
    _, n = _truncate_oversize_strings({"k": "short"}, max_chars=100)
    assert n == 0


def test_truncate_handles_pathological_tiny_cap() -> None:
    """max_chars smaller than the marker itself: just emit the marker.
    Pathological but possible; must not crash with a negative slice."""
    v, _ = _truncate_oversize_strings("aaaaaaaaaa", max_chars=5)
    assert "[truncated" in v
