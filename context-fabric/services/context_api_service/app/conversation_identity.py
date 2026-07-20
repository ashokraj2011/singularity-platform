"""
Conversation identity — deciding WHICH conversation a turn belongs to.

Six incompatible notions of "session" exist in this platform: CF's per-call
correlation tag (derived from workflow ids at execute.py), a synthesis
WorkspaceThread, a PlannerSession row, an MCP auth token, a desktop invocation
id, and room/board surfaces with none at all. Rather than overload a seventh
meaning onto that word, conversations get their own name and their own key.

TWO RULES DO MOST OF THE WORK HERE.

1. CF NEVER INVENTS A CONVERSATION. If a caller does not supply an id and its
   surface has no derivation rule, the answer is None and the turn is stateless.
   That is what keeps the ten one-shot extractors (spec-gen, board-ingestion,
   impact assessment, reconciliation, consumable-verify, discovery, contracts…)
   stateless. Giving them history would be a correctness regression, not a
   feature: they are pure functions over their input, and prior turns would leak
   one document's analysis into the next.

2. A WORKFLOW CONVERSATION IS SCOPED TO THE INSTANCE, NOT THE NODE. CF's
   existing derivation is `wf:{instance}:{node}`, which makes every node its own
   mind — PLAN cannot see what DESIGN concluded. Cross-node continuity is the
   entire point of the `initial_history` parameter that has sat plumbed and
   unpopulated. So the conversation is the instance; the node id rides along as
   a per-turn attribute instead.

The shape is `{surface}:{scope_kind}:{scope_id}` — readable in a log, greppable,
and namespaced so two surfaces cannot collide on a shared underlying id.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional, Tuple

# Bound the key so a hostile or malformed scope id cannot produce an unbounded
# primary key. Long enough for a UUID-bearing composite with room to spare.
MAX_CONVERSATION_ID_CHARS = 200

# Surfaces that carry conversation state, and where their scope id comes from.
# A surface absent from this table gets NO conversation unless the caller passes
# one explicitly — see rule 1 above.
_SURFACE_RULES: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    # surface       -> (scope_kind, run_context keys to try in order)
    "synthesis":     ("thread",   ("thread_id", "threadId")),
    "room_copilot":  ("room",     ("room_id", "roomId")),
    "board_copilot": ("board",    ("board_id", "boardId")),
    "planner":       ("session",  ("planner_session_id", "plannerSessionId")),
}

# Surface aliases: callers already send these strings today, and normalising
# here means no caller has to change its `surface` value to gain memory.
_SURFACE_ALIASES: Dict[str, str] = {
    "synthesis": "synthesis",
    "ask": "synthesis",
    "ask_sidecar": "synthesis",
    "working_session": "synthesis",
    "room": "room_copilot",
    "rooms": "room_copilot",
    "room-copilot": "room_copilot",
    "board": "board_copilot",
    "boards": "board_copilot",
    "board-copilot": "board_copilot",
    "planner": "planner",
}

# Short prefixes keep the key readable at a glance in logs and DB rows.
_SURFACE_PREFIX: Dict[str, str] = {
    "synthesis": "sy",
    "room_copilot": "rm",
    "board_copilot": "bd",
    "planner": "pl",
    "workflow": "wf",
}

_SAFE_SCOPE = re.compile(r"[^A-Za-z0-9_.:-]")


def normalize_surface(surface: Optional[str]) -> Optional[str]:
    if not surface:
        return None
    key = str(surface).strip().lower().replace(" ", "_")
    # A canonical surface name always resolves to itself. Relying on the alias
    # table alone meant "room_copilot" — the canonical value the rules are keyed
    # by — normalised to None, so the surface silently lost its conversation
    # while the hyphenated alias worked.
    if key in _SURFACE_RULES:
        return key
    return _SURFACE_ALIASES.get(key)


def _clean_scope_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    # Colons are the key's own delimiter; letting one through would let a scope
    # id forge a different surface's namespace.
    return _SAFE_SCOPE.sub("_", text.replace(":", "_"))


def _get(run_context: Mapping[str, Any], *keys: str) -> Optional[Any]:
    for key in keys:
        if key in run_context and run_context[key] not in (None, ""):
            return run_context[key]
    return None


def build_conversation_id(surface: str, scope_kind: str, scope_id: str) -> Optional[str]:
    prefix = _SURFACE_PREFIX.get(surface, surface)
    cleaned = _clean_scope_id(scope_id)
    if not cleaned:
        return None
    candidate = f"{prefix}:{scope_kind}:{cleaned}"
    if len(candidate) > MAX_CONVERSATION_ID_CHARS:
        return None
    return candidate


def resolve_conversation(
    run_context: Optional[Mapping[str, Any]],
    explicit_id: Optional[str] = None,
) -> Optional[Dict[str, Optional[str]]]:
    """Resolve the conversation for a turn, or None when it has none.

    Precedence: explicit > derived-from-surface > workflow instance > None.

    Returns `{conversation_id, surface, scope_kind, scope_id}` so a caller can
    record the parts without re-parsing the key it just built.
    """
    if explicit_id:
        cleaned = str(explicit_id).strip()
        if cleaned and len(cleaned) <= MAX_CONVERSATION_ID_CHARS:
            return {
                "conversation_id": cleaned,
                "surface": normalize_surface((run_context or {}).get("surface")),
                "scope_kind": "explicit",
                "scope_id": cleaned,
            }
        return None

    if not run_context:
        return None

    # An explicit id already on the run_context counts as explicit.
    carried = _get(run_context, "conversation_id", "conversationId")
    if carried:
        return resolve_conversation(run_context, str(carried))

    surface = normalize_surface(run_context.get("surface"))
    if surface and surface in _SURFACE_RULES:
        scope_kind, keys = _SURFACE_RULES[surface]
        scope_id = _get(run_context, *keys)
        if scope_id is not None:
            conversation_id = build_conversation_id(surface, scope_kind, scope_id)
            if conversation_id:
                return {
                    "conversation_id": conversation_id,
                    "surface": surface,
                    "scope_kind": scope_kind,
                    "scope_id": _clean_scope_id(scope_id),
                }
        # A known conversational surface with no usable scope id is stateless
        # rather than pooled: falling through to the workflow rule below could
        # merge unrelated chats into one workflow-instance conversation.
        return None

    # Workflow nodes. Scoped to the INSTANCE so ACT can see what PLAN said.
    instance = _get(run_context, "workflow_instance_id", "workflowInstanceId")
    if instance is not None:
        conversation_id = build_conversation_id("workflow", "instance", instance)
        if conversation_id:
            return {
                "conversation_id": conversation_id,
                "surface": "workflow",
                "scope_kind": "instance",
                "scope_id": _clean_scope_id(instance),
            }

    # Everything else is deliberately stateless. See rule 1.
    return None


def call_group_id(
    workflow_instance_id: Optional[str],
    workflow_node_id: Optional[str],
    cf_call_id: str,
) -> str:
    """The per-call correlation tag CF has always computed.

    Unchanged behaviour, named honestly. It was called `session_id`, which made
    it look like conversation state; it is not — with no workflow ids it is a
    fresh uuid per call, so nothing could ever accumulate under it. Conversation
    state now lives under `conversation_id` instead.

    Every PERSISTED field keeps its old name (call_log.session_id,
    receipts.sessionId) so existing audit consumers are unaffected.
    """
    if workflow_instance_id and workflow_node_id:
        return f"wf:{workflow_instance_id}:{workflow_node_id}"
    return f"cf:{cf_call_id}"
