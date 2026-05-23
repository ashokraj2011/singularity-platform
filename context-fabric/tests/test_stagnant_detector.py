"""M74 Phase 1D — stagnant-phase detector tests.

Tests the pure helpers ``_turn_tool_signatures`` and
``_turn_made_progress`` from stage_driver. The integration with
``run_stage`` (where these are called in a loop with a sliding window)
is exercised indirectly by the governed loop suite.

The detector's job: distinguish "real loop" (model keeps calling the
same refused tool) from "slow progress" (model reads different files
over several turns before submitting a phase output).
"""
from __future__ import annotations

from collections import deque
from types import SimpleNamespace

from context_api_service.app.governed.stage_driver import (
    _turn_made_progress,
    _turn_tool_signatures,
)


def _outcome(tool_name: str, args: dict, *, allowed: bool = True) -> SimpleNamespace:
    return SimpleNamespace(tool_name=tool_name, args=args, allowed=allowed)


def _turn(outcomes: list[SimpleNamespace]) -> SimpleNamespace:
    return SimpleNamespace(step=SimpleNamespace(tool_outcomes=outcomes))


# ── _turn_tool_signatures ───────────────────────────────────────────────────


def test_signatures_for_distinct_calls():
    turn = _turn([
        _outcome("read_file", {"path": "a.py"}),
        _outcome("read_file", {"path": "b.py"}),
        _outcome("search_code", {"query": "foo"}),
    ])
    sigs = _turn_tool_signatures(turn)
    assert len(sigs) == 3


def test_signatures_dedupe_identical_calls():
    """Two read_file(a.py) calls in one turn produce one signature."""
    turn = _turn([
        _outcome("read_file", {"path": "a.py"}),
        _outcome("read_file", {"path": "a.py"}),
    ])
    sigs = _turn_tool_signatures(turn)
    assert len(sigs) == 1


def test_signatures_arg_order_insensitive():
    """Canonical JSON sorts keys, so {'a':1,'b':2} == {'b':2,'a':1}."""
    sig1 = _turn_tool_signatures(_turn([_outcome("t", {"a": 1, "b": 2})]))
    sig2 = _turn_tool_signatures(_turn([_outcome("t", {"b": 2, "a": 1})]))
    assert sig1 == sig2


def test_signatures_exclude_refused_calls():
    """Refused calls are the failure mode the detector exists to catch;
    counting them as progress would defeat the purpose."""
    turn = _turn([
        _outcome("apply_patch", {"patch": "..."}, allowed=False),
        _outcome("apply_patch", {"patch": "..."}, allowed=False),
    ])
    sigs = _turn_tool_signatures(turn)
    assert sigs == set()


def test_signatures_empty_when_no_calls():
    """A phase_output-only turn (no tool calls) produces no signatures."""
    turn = _turn([])
    assert _turn_tool_signatures(turn) == set()


def test_signatures_handle_unserialisable_args():
    """Defensive: an args dict that can't be JSON-serialised falls back
    to repr. Won't reach here in practice (validator strips at outcome
    construction) but the helper shouldn't crash the whole turn."""
    class _NoJson:
        def __repr__(self) -> str:
            return "<NoJson>"
    turn = _turn([_outcome("t", {"bad": _NoJson()})])
    sigs = _turn_tool_signatures(turn)
    assert len(sigs) == 1  # didn't crash


# ── _turn_made_progress ─────────────────────────────────────────────────────


def test_progress_on_brand_new_signature():
    """Empty window + any signatures → progress."""
    window: deque[set[str]] = deque(maxlen=4)
    assert _turn_made_progress({"read_file:{'path':'a.py'}"}, window) is True


def test_no_progress_when_signature_in_window():
    """Repeating the same signature seen in the recent window → no progress.
    This is the real-loop case."""
    window: deque[set[str]] = deque(
        [{"apply_patch:{'patch':'x'}"}], maxlen=4,
    )
    assert _turn_made_progress({"apply_patch:{'patch':'x'}"}, window) is False


def test_progress_when_one_new_alongside_one_old():
    """A turn with both a repeat AND a novel call counts as progress —
    the model is making forward motion on at least one front."""
    window: deque[set[str]] = deque(
        [{"read_file:{'path':'a.py'}"}], maxlen=4,
    )
    sigs = {"read_file:{'path':'a.py'}", "read_file:{'path':'b.py'}"}
    assert _turn_made_progress(sigs, window) is True


def test_no_progress_when_no_signatures():
    """Empty turn → not progress regardless of window. A turn that did
    nothing can't claim it did something new."""
    window: deque[set[str]] = deque(
        [{"read_file:{'path':'a.py'}"}], maxlen=4,
    )
    assert _turn_made_progress(set(), window) is False


def test_signature_falls_out_of_window():
    """After maxlen turns, an old signature is no longer in the window
    and re-emerging counts as progress. Intentional: re-reading after
    long enough might be legitimate (file may have changed)."""
    window: deque[set[str]] = deque(maxlen=2)
    window.append({"read_file:{'path':'a.py'}"})
    window.append({"search_code:{'query':'foo'}"})
    window.append({"read_file:{'path':'b.py'}"})  # pushes read_file(a) out
    # read_file(a) is no longer in the window
    assert _turn_made_progress({"read_file:{'path':'a.py'}"}, window) is True


# ── scenario: slow exploration ──────────────────────────────────────────────


def test_scenario_distinct_file_reads_keeps_resetting():
    """The motivating "slow progress" case: 4 turns of distinct read_file
    calls. Each turn introduces a new signature, none should trip the
    stagnant guard."""
    window: deque[set[str]] = deque(maxlen=4)
    files = ["a.py", "b.py", "c.py", "d.py"]
    for path in files:
        sigs = _turn_tool_signatures(_turn([_outcome("read_file", {"path": path})]))
        assert _turn_made_progress(sigs, window) is True, f"path={path} should be progress"
        window.append(sigs)


def test_scenario_real_loop_after_3_repeats_signals_stagnant():
    """The motivating "real loop" case: 3 turns of identical refused
    apply_patch. Turn 1 is empty (refused → no signatures → not
    progress). Turns 2 and 3 same. The caller (run_stage) increments
    the stagnant counter on each → trips at threshold=3."""
    window: deque[set[str]] = deque(maxlen=4)
    no_progress_count = 0
    for _ in range(3):
        sigs = _turn_tool_signatures(_turn([
            _outcome("apply_patch", {"patch": "x"}, allowed=False),
        ]))
        if not _turn_made_progress(sigs, window):
            no_progress_count += 1
        window.append(sigs)
    assert no_progress_count == 3  # all three turns were stagnant
