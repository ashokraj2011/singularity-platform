"""ReviewPlanReceipt — permissive target_files synthesis.

Reviewer agents (SECURITY, DEVOPS) routinely omit a top-level
``target_files`` field and instead embed the scope inside
``review_strategy.files`` or other alias keys. Without lenient synthesis
the receipt fails with "Field required" before any field-level
coercion runs, and the stage burns its budget on a syntactic mismatch
that adds no information.

Repro (2026-05-26, session ef0e849e):
  security-review attempts ca36dffe and 5bfe05dc both submitted PLAN
  output with ``review_strategy: {files: [...]}`` but no top-level
  ``target_files``. Validation rejected with
  ``target_files: Field required`` and the stage failed.

The model_validator ``_synthesize_target_files`` walks a ranked list
of candidate keys before pydantic enforces the required field, so
common reviewer shapes round-trip cleanly.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from context_api_service.app.governed.receipts import (
    ReceiptKind,
    ReviewPlanReceipt,
)


def test_explicit_target_files_wins():
    """When the agent supplies target_files explicitly, synthesis is a no-op."""
    r = ReviewPlanReceipt(
        kind=ReceiptKind.PLAN,
        target_files=["a.java"],
        review_strategy={"files": ["b.java"]},
    )
    assert r.target_files == ["a.java"]


def test_synthesize_from_review_strategy_files():
    """The most common reviewer-agent shape."""
    r = ReviewPlanReceipt(
        kind=ReceiptKind.PLAN,
        review_strategy={"files": ["src/auth/Login.java", "src/api/Controller.java"]},
    )
    assert r.target_files == ["src/auth/Login.java", "src/api/Controller.java"]


def test_synthesize_from_review_strategy_target_files_alias():
    """review_strategy.target_files — nested duplicate key."""
    r = ReviewPlanReceipt(
        kind=ReceiptKind.PLAN,
        review_strategy={"target_files": ["x.java"]},
    )
    assert r.target_files == ["x.java"]


def test_synthesize_from_top_level_files_to_review():
    r = ReviewPlanReceipt(kind=ReceiptKind.PLAN, files_to_review=["x.java"])
    assert r.target_files == ["x.java"]


def test_synthesize_from_top_level_inspect_files():
    r = ReviewPlanReceipt(kind=ReceiptKind.PLAN, inspect_files=["i.java"])
    assert r.target_files == ["i.java"]


def test_synthesize_from_top_level_paths_in_scope():
    r = ReviewPlanReceipt(kind=ReceiptKind.PLAN, paths_in_scope=["p.java"])
    assert r.target_files == ["p.java"]


def test_synthesize_from_nested_scope_files():
    r = ReviewPlanReceipt(kind=ReceiptKind.PLAN, scope={"files": ["s.java"]})
    assert r.target_files == ["s.java"]


def test_empty_target_files_falls_through_to_synthesis():
    """target_files: [] is not "populated" — fall through to alternates."""
    r = ReviewPlanReceipt(
        kind=ReceiptKind.PLAN,
        target_files=[],
        review_strategy={"files": ["fallback.java"]},
    )
    assert r.target_files == ["fallback.java"]


def test_review_strategy_files_takes_priority_over_top_level_files():
    """review_strategy.files is more specific than a generic top-level
    `files`, so it wins."""
    r = ReviewPlanReceipt(
        kind=ReceiptKind.PLAN,
        review_strategy={"files": ["in_strategy.java"]},
        files=["top_level.java"],
    )
    assert r.target_files == ["in_strategy.java"]


def test_synthesize_preserves_per_file_dict_shape_for_field_coercion():
    """Synthesis hands off to _coerce_target_files; structured per-file
    dicts should still get flattened to paths."""
    r = ReviewPlanReceipt(
        kind=ReceiptKind.PLAN,
        review_strategy={"files": [
            {"file": "a.java", "reason": "auth check"},
            {"path": "b.java", "concern": "input validation"},
        ]},
    )
    assert r.target_files == ["a.java", "b.java"]


def test_no_synthesis_source_raises_validation_error():
    """When no candidate key supplies a list, the receipt fails — better
    a clear error than silently shipping with empty scope."""
    with pytest.raises(ValidationError) as exc_info:
        ReviewPlanReceipt(kind=ReceiptKind.PLAN)
    errors = exc_info.value.errors()
    assert any(e["loc"] == ("target_files",) for e in errors)


def test_non_dict_input_passes_through():
    """If `data` arrives as something other than a dict (shouldn't happen
    in normal use but defensive against future caller bugs), the
    synthesizer should not crash — pydantic surfaces the type error."""
    with pytest.raises(ValidationError):
        ReviewPlanReceipt.model_validate("not a dict")
