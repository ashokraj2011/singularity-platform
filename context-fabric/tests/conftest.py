"""Shared fixtures for the context-compiler unit tests.

These tests exercise context_memory_service.app.context_compiler in-process
with NO database and NO HTTP: the repository read functions (get_messages,
get_latest_summary, list_memory_items) and the write (insert_context_package)
are monkeypatched, while the real tiktoken-backed token_counter is used so
budget/accounting arithmetic is exact and deterministic.

IMPORTANT: patch the names AS IMPORTED INTO context_compiler (it does
`from .repository import get_messages, ...` at module load), not the
repository module.
"""
from __future__ import annotations

import pytest

from context_memory_service.app import context_compiler as cc


def make_rows(n: int, content: str = "msg") -> list[dict]:
    """Fabricate `n` alternating user/assistant conversation rows."""
    rows = []
    for i in range(n):
        rows.append({
            "role": "user" if i % 2 == 0 else "assistant",
            "content": f"{content} {i}",
            "created_at": f"2026-06-01T00:00:{i:02d}",
        })
    return rows


def make_summary(text_lines: list[str]) -> dict:
    """A get_latest_summary-shaped dict whose summary_to_text renders the
    given lines. We stash a simple shape that summary_to_text can format."""
    return {
        "id": "sum-1",
        "version": 1,
        "content": {
            "current_goal": text_lines[0] if text_lines else "",
            "important_context": text_lines[1:],
        },
        "created_at": "2026-06-01T00:00:00",
    }


def make_memory_items(n: int) -> list[dict]:
    return [
        {
            "id": f"mem-{i}",
            "memory_type": "fact",
            "content": f"memory item {i} about deployment and tokens",
            "importance_score": 0.5,
            "confidence": 0.8,
        }
        for i in range(n)
    ]


@pytest.fixture
def patch_repo(monkeypatch):
    """Returns a configurable installer so each test sets its own data.

    Usage:
        patch_repo(messages=[...], summary={...} or None, memory=[...])
    """
    def _install(messages=None, summary=None, memory=None):
        msgs = messages if messages is not None else []

        def fake_get_messages(session_id, limit=None, ascending=True):
            rows = list(msgs)
            # mirror repository semantics: limit takes the most recent rows,
            # result returned oldest→newest.
            if limit is not None and limit < len(rows):
                rows = rows[-limit:]
            return rows if ascending else list(rows)

        monkeypatch.setattr(cc, "get_messages", fake_get_messages)
        monkeypatch.setattr(cc, "get_latest_summary", lambda session_id: summary)
        monkeypatch.setattr(
            cc, "list_memory_items",
            lambda agent_id=None, session_id=None, limit=100: list(memory or []),
        )
        monkeypatch.setattr(cc, "insert_context_package", lambda payload: "ctx-test-1")
        # Avoid prompt-composer network lookup for the default system prompt.
        monkeypatch.setattr(cc, "_get_default_system_prompt_sync", lambda: "SYS")

    return _install
