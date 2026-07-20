"""
Conversation store — durable cross-turn memory for every LLM surface.

The problem this exists to solve: the governed subsystem is stateless.
`execute_governed_single_turn` builds its message list as literally
`[system_prompt?, user_task]`, so the Ask sidecar, the Conversational Studio's
conductor, room-copilot, board-copilot and Event Horizon all reach the model
with ZERO prior turns. Synthesis persists a tenant-scoped, fenced-sequence
transcript that no LLM ever reads back. `initial_history` is plumbed through
four layers and hardcoded to `[]` at its only caller. Planner is the one surface
with real memory, and it gets there by flattening the whole transcript into the
task string, uncapped.

Design notes worth knowing before editing:

WHY CF OWNS THIS. workgraph already has a beautiful transcript model
(WorkspaceThread/WorkspaceMessage: tenant-scoped, RLS-enforced, gap-free seq).
It is the wrong home anyway — `WorkspaceThread.workspaceId` is a required FK to
SynthesisWorkspace, which requires a SpecificationProject. Planner, room-copilot,
Event Horizon and workflow nodes have no workspace, so adopting it would mean
minting fake ones per chat. CF also has no workgraph URL: today's dependency
runs workgraph -> CF, so reading transcripts back would invert it and put a
Node/Prisma hop inside every LLM call. And agent-service and prompt-composer
call CF's single-turn endpoint directly, bypassing workgraph entirely — they
would get no memory at all.

WHY "conversation", NEVER "session". "Session" already means five different
things here: CF's per-call correlation tag, a synthesis thread, a planner row, an
MCP auth token, and a desktop invocation id. A new name collides with none of
them.

WHAT IS NOT STORED. Tool-role messages and assistant tool_use blocks are never
conversation-eligible — only user turns and final assistant text. That is a
safety property, not a space optimisation: an orphaned tool_result (a
tool_result with no matching tool_use) makes Anthropic 400 the whole request,
and CF's governed loop has no orphan repair. If tool traffic is never persisted,
it can never be replayed into a prompt half-formed.

Tenancy is app-level, matching call_log and the rest of CF
(`_resolve_read_tenant_scope` / `configured_tenant_ids_for_service_token`).
Conversation turns are raw user text, so this is the weakest protection on the
most sensitive data in the platform; forced RLS is a tracked follow-up.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from context_fabric_shared.database import (
    db_conn,
    resolve_database_target,
    row_to_dict,
    rows_to_dicts,
)


DEFAULT_CONVERSATION_DB = "./data/conversations.db"
DB_TARGET = resolve_database_target(
    "CONVERSATION_STORE_DATABASE_URL", "CONVERSATION_STORE_DB", DEFAULT_CONVERSATION_DB
)

# Only these roles are conversation-eligible. See the module docstring: keeping
# tool traffic out is what makes orphaned tool_result impossible by construction.
PERSISTABLE_ROLES = ("user", "assistant")


def refresh_db_target() -> None:
    global DB_TARGET
    DB_TARGET = resolve_database_target(
        "CONVERSATION_STORE_DATABASE_URL",
        "CONVERSATION_STORE_DB",
        os.environ.get("CONVERSATION_STORE_DB", DEFAULT_CONVERSATION_DB),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    """Create the tables. Idempotent; called at startup alongside the other stores."""
    refresh_db_target()
    with db_conn(DB_TARGET) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cf_conversations (
                conversation_id TEXT PRIMARY KEY,
                tenant_id TEXT,
                user_id TEXT,
                surface TEXT,
                scope_kind TEXT,
                scope_id TEXT,
                capability_id TEXT,
                agent_role TEXT,
                head_seq INTEGER NOT NULL DEFAULT 0,
                summary_text TEXT,
                summary_through_seq INTEGER NOT NULL DEFAULT 0,
                summary_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'ACTIVE',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_turn_at TEXT,
                expires_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cf_conversation_turns (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                tokens INTEGER NOT NULL DEFAULT 0,
                cf_call_id TEXT,
                trace_id TEXT,
                tenant_id TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        # The fence. Two concurrent turns on one conversation must not take the
        # same seq; the unique index is what turns that race into an error
        # instead of a silently reordered transcript.
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_turns_conversation_seq
                ON cf_conversation_turns(conversation_id, seq)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_cf_turns_conversation_created
                ON cf_conversation_turns(conversation_id, created_at)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_cf_conversations_tenant
                ON cf_conversations(tenant_id, updated_at)
            """
        )


def ensure_conversation(
    conversation_id: str,
    *,
    tenant_id: Optional[str] = None,
    user_id: Optional[str] = None,
    surface: Optional[str] = None,
    scope_kind: Optional[str] = None,
    scope_id: Optional[str] = None,
    capability_id: Optional[str] = None,
    agent_role: Optional[str] = None,
) -> None:
    """Create the conversation row if absent. Safe to call on every turn."""
    now = _now()
    with db_conn(DB_TARGET) as conn:
        existing = conn.execute(
            "SELECT conversation_id FROM cf_conversations WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        if existing:
            return
        conn.execute(
            """
            INSERT INTO cf_conversations (
                conversation_id, tenant_id, user_id, surface, scope_kind, scope_id,
                capability_id, agent_role, head_seq, summary_through_seq,
                summary_tokens, total_tokens, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'ACTIVE', ?, ?)
            """,
            (
                conversation_id, tenant_id, user_id, surface, scope_kind, scope_id,
                capability_id, agent_role, now, now,
            ),
        )


def append_turn(
    conversation_id: str,
    role: str,
    content: str,
    *,
    tokens: int = 0,
    cf_call_id: Optional[str] = None,
    trace_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
) -> Optional[int]:
    """Append one turn and return its seq, or None if the role is not eligible.

    Returns None rather than raising for an ineligible role: callers hand us
    whatever the loop produced, and a tool message arriving here is normal, not
    an error.
    """
    if role not in PERSISTABLE_ROLES:
        return None
    if not content or not content.strip():
        # An empty assistant turn is what a pure tool-call turn looks like once
        # its tool_use blocks are stripped. Storing it would put a blank message
        # into the next prompt for no benefit.
        return None

    now = _now()
    with db_conn(DB_TARGET) as conn:
        # Claim the seq by incrementing head_seq in the same statement that reads
        # it, so two concurrent appends cannot both read N and both write N+1.
        row = conn.execute(
            """
            UPDATE cf_conversations
               SET head_seq = head_seq + 1,
                   total_tokens = total_tokens + ?,
                   updated_at = ?,
                   last_turn_at = ?
             WHERE conversation_id = ?
            RETURNING head_seq
            """,
            (tokens, now, now, conversation_id),
        ).fetchone()
        if row is None:
            # No conversation row: the caller skipped ensure_conversation.
            return None
        claimed = row_to_dict(row)
        seq = int(claimed["head_seq"])
        conn.execute(
            """
            INSERT INTO cf_conversation_turns (
                id, conversation_id, seq, role, content, tokens,
                cf_call_id, trace_id, tenant_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()), conversation_id, seq, role, content, tokens,
                cf_call_id, trace_id, tenant_id, now,
            ),
        )
        return seq


def get_conversation(conversation_id: str) -> Optional[Dict[str, Any]]:
    with db_conn(DB_TARGET) as conn:
        row = conn.execute(
            "SELECT * FROM cf_conversations WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        return row_to_dict(row) if row else None


def recent_turns(conversation_id: str, limit: int, *, after_seq: int = 0) -> List[Dict[str, Any]]:
    """The newest `limit` turns after `after_seq`, returned oldest-first.

    Oldest-first because the result goes straight into a prompt. Selecting
    newest-first and reversing in the caller is how transcripts end up backwards.
    """
    if limit <= 0:
        return []
    with db_conn(DB_TARGET) as conn:
        rows = conn.execute(
            """
            SELECT * FROM (
                SELECT * FROM cf_conversation_turns
                 WHERE conversation_id = ? AND seq > ?
                 ORDER BY seq DESC
                 LIMIT ?
            ) AS newest
            ORDER BY seq ASC
            """,
            (conversation_id, after_seq, limit),
        ).fetchall()
        return rows_to_dicts(rows)


def turns_through(conversation_id: str, through_seq: int) -> List[Dict[str, Any]]:
    """Every turn up to and including `through_seq`, oldest-first.

    This is the summariser's input: the span being folded into summary_text.
    """
    with db_conn(DB_TARGET) as conn:
        rows = conn.execute(
            """
            SELECT * FROM cf_conversation_turns
             WHERE conversation_id = ? AND seq <= ?
             ORDER BY seq ASC
            """,
            (conversation_id, through_seq),
        ).fetchall()
        return rows_to_dicts(rows)


def set_summary(
    conversation_id: str, summary_text: str, through_seq: int, tokens: int = 0
) -> None:
    """Record a rolling summary covering everything up to `through_seq`.

    Guarded so a slow summariser cannot move the watermark backwards: two
    summarisation runs can overlap, and the older one finishing last would
    otherwise discard the newer one's coverage.
    """
    with db_conn(DB_TARGET) as conn:
        conn.execute(
            """
            UPDATE cf_conversations
               SET summary_text = ?, summary_through_seq = ?, summary_tokens = ?, updated_at = ?
             WHERE conversation_id = ? AND summary_through_seq < ?
            """,
            (summary_text, through_seq, tokens, _now(), conversation_id, through_seq),
        )
