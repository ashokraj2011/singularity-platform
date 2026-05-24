"""Corpus loader for the capability harness.

A corpus is a JSON file containing a list of `CorpusTask` objects.
Each task describes one bug-fix-style problem the agent should solve:
the goal text, the stage to invoke, the gold reference solution, a
rubric for the LLM judge, and optional per-task overrides.

Validation is strict — a malformed corpus aborts loading rather than
silently dropping tasks, because a quiet drop would inflate the
pass rate (uncounted tasks ≠ failures).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CorpusTask:
    """One benchmark problem. Frozen so a runner can't accidentally
    mutate the corpus mid-run (would make results non-reproducible)."""

    task_id: str
    goal: str
    stage_key: str
    agent_role: str
    rubric: str
    reference_patch: str

    # Optional overrides + Slice-2 hooks.
    model_alias: str | None = None
    max_turns: int | None = None
    # For dry-run: the harness uses this as the "agent's response"
    # instead of calling CF. Lets the scoring pipeline be exercised
    # without burning LLM budget. Slice 2 will use it less (the real
    # sandbox will produce real outputs); Slice 1 leans on it heavily.
    sample_response: dict[str, Any] | None = None
    # Slice 2 will populate workspace setup with these. Slice 1 ignores.
    setup_files: dict[str, str] = field(default_factory=dict)
    # Free-form tags for filtering (e.g. "python", "easy", "swe-lite").
    tags: list[str] = field(default_factory=list)


def load_corpus(path: str | Path) -> list[CorpusTask]:
    """Load + validate a corpus file. Raises ValueError with a clear
    message on any structural problem so the operator sees what's
    wrong before the run starts."""
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"corpus file not found: {p}")
    raw = json.loads(p.read_text())
    if not isinstance(raw, list):
        raise ValueError(
            f"corpus root must be a list of task objects, got {type(raw).__name__}"
        )

    tasks: list[CorpusTask] = []
    seen_ids: set[str] = set()
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError(
                f"corpus entry #{i} must be an object, got {type(entry).__name__}"
            )
        try:
            task = _task_from_dict(entry, index=i)
        except KeyError as exc:
            raise ValueError(
                f"corpus entry #{i}: missing required field {exc}"
            ) from exc
        if task.task_id in seen_ids:
            raise ValueError(
                f"corpus entry #{i}: duplicate task_id {task.task_id!r}"
            )
        seen_ids.add(task.task_id)
        tasks.append(task)

    if not tasks:
        raise ValueError(f"corpus {p} is empty")
    return tasks


def _task_from_dict(entry: dict[str, Any], *, index: int) -> CorpusTask:
    """Build a CorpusTask from one JSON entry. Centralised so the
    required/optional split is explicit and any future field
    additions land in one place."""
    required = ("task_id", "goal", "stage_key", "agent_role", "rubric", "reference_patch")
    for field_name in required:
        if field_name not in entry:
            raise KeyError(field_name)

    setup = entry.get("setup_files") or {}
    if not isinstance(setup, dict):
        raise ValueError(
            f"corpus entry #{index}: setup_files must be an object, got {type(setup).__name__}"
        )
    tags = entry.get("tags") or []
    if not isinstance(tags, list):
        raise ValueError(
            f"corpus entry #{index}: tags must be a list, got {type(tags).__name__}"
        )

    return CorpusTask(
        task_id=str(entry["task_id"]),
        goal=str(entry["goal"]),
        stage_key=str(entry["stage_key"]),
        agent_role=str(entry["agent_role"]),
        rubric=str(entry["rubric"]),
        reference_patch=str(entry["reference_patch"]),
        model_alias=entry.get("model_alias"),
        max_turns=entry.get("max_turns"),
        sample_response=entry.get("sample_response"),
        setup_files={str(k): str(v) for k, v in setup.items()},
        tags=[str(t) for t in tags],
    )
