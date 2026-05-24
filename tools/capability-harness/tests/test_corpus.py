"""Unit tests for the corpus loader.

The harness leans hard on the corpus being well-formed — a silent
parse error would mean uncounted tasks and an inflated pass rate.
These tests pin the validation behavior so a regression surfaces
before a real run.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from corpus import CorpusTask, load_corpus


# ── happy paths ────────────────────────────────────────────────────────────


def test_load_corpus_returns_list_of_tasks(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    p.write_text(json.dumps([
        _minimal_task("a"),
        _minimal_task("b"),
    ]))
    tasks = load_corpus(p)
    assert [t.task_id for t in tasks] == ["a", "b"]
    assert all(isinstance(t, CorpusTask) for t in tasks)


def test_load_corpus_preserves_optional_fields(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    raw = _minimal_task("withopts")
    raw["model_alias"] = "claude-haiku-4-5"
    raw["max_turns"] = 12
    raw["tags"] = ["python", "easy"]
    raw["setup_files"] = {"src/foo.py": "x = 1\n"}
    raw["sample_response"] = {"agent_output": "stub"}
    p.write_text(json.dumps([raw]))
    [task] = load_corpus(p)
    assert task.model_alias == "claude-haiku-4-5"
    assert task.max_turns == 12
    assert task.tags == ["python", "easy"]
    assert task.setup_files == {"src/foo.py": "x = 1\n"}
    assert task.sample_response == {"agent_output": "stub"}


def test_load_corpus_yields_frozen_tasks(tmp_path: Path) -> None:
    """Frozen dataclass guarantees the runner can't mutate tasks
    mid-run. Without this, two parallel scorers could race on the
    same task object and produce non-reproducible results."""
    p = tmp_path / "c.json"
    p.write_text(json.dumps([_minimal_task("a")]))
    [task] = load_corpus(p)
    with pytest.raises((AttributeError, Exception)):  # FrozenInstanceError subclass
        task.task_id = "mutated"  # type: ignore[misc]


# ── validation failures ────────────────────────────────────────────────────


def test_missing_file_raises_filenotfound(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="corpus file not found"):
        load_corpus(tmp_path / "nope.json")


def test_root_must_be_list(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"tasks": []}))
    with pytest.raises(ValueError, match="corpus root must be a list"):
        load_corpus(p)


def test_empty_corpus_rejected(tmp_path: Path) -> None:
    """Empty corpus is almost certainly a bug in the JSON file —
    fail loudly rather than silently report 100% pass."""
    p = tmp_path / "c.json"
    p.write_text(json.dumps([]))
    with pytest.raises(ValueError, match="is empty"):
        load_corpus(p)


def test_entry_must_be_object(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    p.write_text(json.dumps([_minimal_task("a"), "not an object"]))
    with pytest.raises(ValueError, match="entry #1 must be an object"):
        load_corpus(p)


def test_missing_required_field(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    bad = _minimal_task("a")
    del bad["rubric"]
    p.write_text(json.dumps([bad]))
    with pytest.raises(ValueError, match="missing required field.*rubric"):
        load_corpus(p)


def test_duplicate_task_id_rejected(tmp_path: Path) -> None:
    """Duplicate IDs would produce two result rows with the same key
    and corrupt the markdown summary."""
    p = tmp_path / "c.json"
    p.write_text(json.dumps([
        _minimal_task("dup"),
        _minimal_task("dup"),
    ]))
    with pytest.raises(ValueError, match="duplicate task_id 'dup'"):
        load_corpus(p)


def test_setup_files_must_be_object(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    bad = _minimal_task("a")
    bad["setup_files"] = ["not", "a", "dict"]
    p.write_text(json.dumps([bad]))
    with pytest.raises(ValueError, match="setup_files must be an object"):
        load_corpus(p)


def test_tags_must_be_list(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    bad = _minimal_task("a")
    bad["tags"] = "python"  # common operator mistake
    p.write_text(json.dumps([bad]))
    with pytest.raises(ValueError, match="tags must be a list"):
        load_corpus(p)


# ── shipped corpus parses cleanly ──────────────────────────────────────────


def test_shipped_mini3_corpus_loads() -> None:
    """The mini-3 corpus that ships with the harness must always
    parse — a regression here would break the dry-run path everyone
    runs first."""
    shipped = Path(__file__).resolve().parents[1] / "corpora" / "mini-3.json"
    tasks = load_corpus(shipped)
    assert len(tasks) == 3
    assert {t.task_id for t in tasks} == {
        "palindrome_function",
        "contains_a_character",
        "fibonacci_iterative",
    }


# ── helpers ────────────────────────────────────────────────────────────────


def _minimal_task(task_id: str) -> dict:
    return {
        "task_id": task_id,
        "goal": "make it work",
        "stage_key": "loop.stage.develop",
        "agent_role": "DEVELOPER",
        "rubric": "did it work?",
        "reference_patch": "def f(): pass",
    }
