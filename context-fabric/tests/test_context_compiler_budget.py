"""P1 (budget) + P3 (dedup) unit tests for build_optimized_context.

Pure in-process: repository reads are monkeypatched (see conftest.patch_repo),
real tiktoken token counting is used so the budget actually bites.
"""
from __future__ import annotations

from context_fabric_shared.token_counter import count_text_tokens, trim_text_to_tokens
from context_memory_service.app import context_compiler as cc
from conftest import make_rows, make_summary, make_memory_items


# ── P1: the current user message is NEVER truncated under budget pressure ──

def test_current_user_message_survives_tiny_budget(patch_repo):
    # Lots of long history + summary + memory, but a tiny budget.
    long_rows = make_rows(40, content="x" * 400)
    patch_repo(
        messages=long_rows,
        summary=make_summary(["goal " + "g" * 500] + ["ctx " + "c" * 500 for _ in range(8)]),
        memory=make_memory_items(20),
    )
    user_message = "PLEASE_ANSWER_THIS_EXACT_QUESTION_42"

    messages, included = cc.build_optimized_context(
        session_id="s1", agent_id="a1", user_message=user_message,
        mode="aggressive", max_context_tokens=300,
    )

    block = messages[-1]["content"]
    # The user's actual question must appear verbatim ...
    assert user_message in block
    # ... and be the LAST section (nothing after the current-message block).
    assert block.rstrip().endswith(user_message)
    assert "[CURRENT USER MESSAGE]" in block
    # Budget pressure should have trimmed SOMETHING (older sections).
    assert "trimmed" in included


def test_current_user_message_survives_even_when_alone_too_big(patch_repo):
    # Degenerate case: the user message alone exceeds the budget. We still
    # emit it in full rather than silently dropping the question.
    patch_repo(messages=make_rows(4), summary=None, memory=[])
    big_user = "Q " + "word " * 2000  # far bigger than the budget

    messages, _ = cc.build_optimized_context(
        session_id="s1", agent_id=None, user_message=big_user,
        mode="medium", max_context_tokens=200,
    )
    assert big_user in messages[-1]["content"]


def test_no_budget_pressure_keeps_all_sections(patch_repo):
    patch_repo(
        messages=make_rows(6, content="short"),
        summary=make_summary(["the goal", "some context"]),
        memory=make_memory_items(3),
    )
    messages, included = cc.build_optimized_context(
        session_id="s1", agent_id="a1", user_message="hello there",
        mode="medium", max_context_tokens=16000,
    )
    block = messages[-1]["content"]
    assert "[ROLLING SESSION SUMMARY]" in block
    assert "[RELEVANT MEMORY]" in block
    assert "[RECENT MESSAGES]" in block
    assert "hello there" in block
    assert "trimmed" not in included


# ── P3: recent messages duplicated in the summary are dropped once ──

def test_recent_line_present_in_summary_is_deduped(patch_repo):
    dup = "we decided to ship the gateway on friday"
    rows = make_rows(4, content="filler")
    # Make the most-recent user row exactly the duplicated line.
    rows[-1] = {"role": "user", "content": dup, "created_at": "2026-06-01T00:00:09"}
    # Summary's important_context contains the same text (rendered as "- {item}").
    summary = make_summary(["the goal", dup, "another distinct point"])

    patch_repo(messages=rows, summary=summary, memory=[])
    messages, included = cc.build_optimized_context(
        session_id="s1", agent_id="a1", user_message="next?",
        mode="medium", max_context_tokens=16000,
    )
    block = messages[-1]["content"]
    # The duplicated phrase should appear once (in the summary), not twice.
    assert block.count(dup) == 1
    assert "recent_deduped_vs_summary" in included


# ── trim_text_to_tokens primitive ──

def test_trim_text_to_tokens_respects_budget():
    text = "alpha beta gamma delta " * 200
    trimmed = trim_text_to_tokens(text, 20)
    assert count_text_tokens(trimmed) <= 20
    # Already-fitting text is returned unchanged.
    assert trim_text_to_tokens("short", 50) == "short"
    assert trim_text_to_tokens("anything", 0) == ""
