"""
M90.E — Per-tool input schemas for the descriptors handed to the LLM.

Pre-M90.E `_build_tool_descriptors` (turn.py) emitted `{type: "object"}`
with no properties for every tool. That was intentional under M72 Slice
A to keep the descriptor list cache-stable across phases — providers'
prompt caches hash the full tool list and any per-turn variance
invalidates the prefix. The cost of that stability: the LLM had no
shape information, so it routinely emitted wrong arg names
(`filePath` vs `path`, `old_text` vs `oldText`, etc.) and burned turns
on PHASE_TOOL_FORBIDDEN / shape errors that a real schema would have
prevented.

This module restores real schemas WITHOUT breaking cache stability:
the schemas are MODULE CONSTANTS (no per-turn variation), keyed by
tool_name. _build_tool_descriptors now looks each tool up here.
Because tool_descriptors are the union across the stage's phases
(also stable), the resulting descriptor list is byte-stable across
the stage's lifetime.

Two design decisions:

  1. Hand-authored, not auto-derived from mcp-server. M71 Slice D
     specifically broke the CF → mcp-server import dependency
     (mcp-server is now a dumb runner; CF doesn't know about its
     internals). Re-introducing a runtime fetch would re-introduce
     the coupling. Hand-authoring here is the right amount of
     duplication — schemas change rarely, and the canonical
     contract is what the LLM sees, not what mcp-server emits.

  2. Lenient additionalProperties. We do NOT set
     additionalProperties=false because mcp-server's tool-arg
     normalizer (M134) accepts a small set of legacy aliases
     (`filePath → path`, `old_text → oldText`). Strict schema
     validation would prevent the model from using ANY alias,
     including ones the runner cleans up — costing more turns
     than the strictness gains.

If a tool isn't listed here, _build_tool_descriptors falls back to
`{type: "object"}` — the same bare schema we used before — so
unknown tools (custom runners, capabilities-specific tools, new
additions) keep working with degraded shape information rather
than refusing to dispatch.
"""
from __future__ import annotations

from typing import Any


# Common shapes reused across multiple tools.
_PATH_PROP = {
    "type": "string",
    "description": "Workspace-relative file path (e.g. 'src/foo/Bar.java').",
}
_LINE_RANGE_PROPS = {
    "startLine": {
        "type": "integer",
        "minimum": 1,
        "description": "1-indexed inclusive starting line.",
    },
    "endLine": {
        "type": "integer",
        "minimum": 1,
        "description": "1-indexed inclusive ending line.",
    },
}
_COMMAND_PROP = {
    "type": "string",
    "description": "Shell-style verifier command (e.g. 'mvn test' or 'pytest tests/').",
}


# Per-tool input schemas. Keyed by the tool_name that the gateway emits.
# Properties are described in the LLM-facing schema language so the
# model gets human-readable hints alongside the type constraints.
TOOL_INPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    # ─── File reads ───────────────────────────────────────────────────
    "read_file": {
        "type": "object",
        "required": ["path"],
        "properties": {
            "path": _PATH_PROP,
            **_LINE_RANGE_PROPS,
        },
    },
    "list_files": {
        "type": "object",
        "properties": {
            "path": {**_PATH_PROP, "description": "Workspace-relative directory."},
            "pattern": {
                "type": "string",
                "description": "Optional glob (e.g. '*.java').",
            },
        },
    },
    "list_indexed_files": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Optional glob to filter the AST index.",
            },
        },
    },
    "repo_map": {
        "type": "object",
        "properties": {
            "path": {**_PATH_PROP, "description": "Optional subtree to map."},
        },
    },
    "get_ast_slice": {
        "type": "object",
        "required": ["path", "startLine", "endLine"],
        "properties": {
            "path": _PATH_PROP,
            **_LINE_RANGE_PROPS,
        },
    },
    "find_symbol": {
        "type": "object",
        "required": ["name"],
        "properties": {
            "name": {
                "type": "string",
                "description": "Symbol name to locate (class, method, field).",
            },
            "kind": {
                "type": "string",
                "description": "Optional filter: 'class' | 'method' | 'field' | 'function'.",
            },
        },
    },
    "symbol_search": {
        "type": "object",
        "required": ["query"],
        "properties": {
            "query": {
                "type": "string",
                "description": "Symbol substring or qualified name to search for.",
            },
        },
    },
    "search_code": {
        "type": "object",
        "required": ["pattern"],
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regex or literal text to find across the workspace.",
            },
            "path": {**_PATH_PROP, "description": "Optional subtree to scope the search."},
        },
    },
    "grep_lines": {
        "type": "object",
        "required": ["pattern"],
        "properties": {
            "pattern": {"type": "string", "description": "Regex or literal text."},
            "path": {**_PATH_PROP, "description": "Optional subtree."},
        },
    },
    "get_dependencies": {
        "type": "object",
        "required": ["path"],
        "properties": {
            "path": _PATH_PROP,
        },
    },
    # ─── Mutating tools ───────────────────────────────────────────────
    "apply_patch": {
        "type": "object",
        "required": ["patch"],
        "properties": {
            "patch": {
                "type": "string",
                "description": (
                    "Unified diff patch text. Must include 'diff --git', '--- a/...', "
                    "'+++ b/...' headers and standard @@ hunks."
                ),
            },
        },
    },
    "replace_text": {
        "type": "object",
        "required": ["path", "oldText", "newText"],
        "properties": {
            "path": _PATH_PROP,
            "oldText": {
                "type": "string",
                "description": (
                    "Exact text to find. Must be unique within the file or the "
                    "tool refuses (use a longer surrounding context to disambiguate)."
                ),
            },
            "newText": {
                "type": "string",
                "description": "Replacement text. Empty string deletes oldText.",
            },
        },
    },
    "replace_range": {
        "type": "object",
        "required": ["path", "startLine", "endLine", "newText"],
        "properties": {
            "path": _PATH_PROP,
            **_LINE_RANGE_PROPS,
            "newText": {
                "type": "string",
                "description": "Replacement text for lines startLine..endLine inclusive.",
            },
        },
    },
    "write_file": {
        "type": "object",
        "required": ["path", "content"],
        "properties": {
            "path": _PATH_PROP,
            "content": {
                "type": "string",
                "description": "Full file contents — overwrites the file at path.",
            },
        },
    },
    "create_file": {
        "type": "object",
        "required": ["path", "content"],
        "properties": {
            "path": _PATH_PROP,
            "content": {"type": "string", "description": "Initial file contents."},
        },
    },
    # ─── Verifier dispatch ────────────────────────────────────────────
    "run_test": {
        "type": "object",
        "required": ["command"],
        "properties": {
            "command": _COMMAND_PROP,
            "args": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional positional args passed to command.",
            },
            "cwd": {
                "type": "string",
                "description": "Optional subdirectory (relative to workspace root).",
            },
            "timeout_sec": {
                "type": "integer",
                "minimum": 1,
                "description": "Hard cap; default per-runner.",
            },
        },
    },
    "run_command": {
        "type": "object",
        "required": ["command"],
        "properties": {
            "command": _COMMAND_PROP,
            "args": {"type": "array", "items": {"type": "string"}},
            "cwd": {"type": "string"},
            "timeout_sec": {"type": "integer", "minimum": 1},
        },
    },
    "capture_test_baseline": {
        "type": "object",
        "required": ["command"],
        "properties": {
            "command": {
                **_COMMAND_PROP,
                "description": (
                    "Same as run_test's command. Run this BEFORE editing — "
                    "the receipt is tagged as the baseline so subsequent "
                    "run_test calls auto-diff against it (pre-existing "
                    "failures pass the gate; only new regressions block)."
                ),
            },
            "args": {"type": "array", "items": {"type": "string"}},
            "cwd": {"type": "string"},
        },
    },
    # ─── Git / workflow ───────────────────────────────────────────────
    "finish_work_branch": {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "Commit message. Required when there are pending changes.",
            },
        },
    },
    "review_diff": {
        "type": "object",
        "properties": {
            "paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional paths to scope the diff to.",
            },
        },
    },
    # ─── Verifier synthesis / fallback ────────────────────────────────
    "recommended_verification": {
        "type": "object",
        "properties": {
            "changed_paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Files the agent's edits touched. The synthesizer uses "
                    "these to pick the smallest verifier scope."
                ),
            },
        },
    },
    "verification_unavailable": {
        "type": "object",
        "required": ["reason"],
        "properties": {
            "reason": {
                "type": "string",
                "description": (
                    "One-line explanation why a verifier couldn't run "
                    "(e.g. 'no test framework configured', 'verifier-registry "
                    "returned no candidates'). Reviewers decide if the gap is acceptable."
                ),
            },
        },
    },
    # ─── Misc audit/probe tools ───────────────────────────────────────
    "detect_no_tests_ran": {
        "type": "object",
        "required": ["stdout"],
        "properties": {
            "stdout": {
                "type": "string",
                "description": "Captured test-runner stdout.",
            },
            "command": {
                "type": "string",
                "description": "Optional command for context.",
            },
        },
    },
    "classify_push_error": {
        "type": "object",
        "required": ["stderr"],
        "properties": {
            "stderr": {
                "type": "string",
                "description": "Captured git push stderr.",
            },
        },
    },
    "read_workitem": {
        "type": "object",
        "properties": {
            "work_item_id": {
                "type": "string",
                "description": "Optional override; defaults to the run_context's work_item_id.",
            },
        },
    },
    "read_repo_instructions": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Optional path; defaults to standard locations (CLAUDE.md, AGENTS.md).",
            },
        },
    },
}


# M91.A (2026-05-27) — Tool categorisation. Lets a StageExecutionPolicy
# filter the tool union by category (READ_ONLY keeps only `read`,
# MUTATION lets everything through, VERIFICATION keeps `read+run`, etc.)
# Unlisted tools default to `unknown` → conservatively allowed only when
# tool_policy=MUTATION (the "full kit" mode). Add new tools here when
# they ship so the policy filter knows which bucket they belong to.
TOOL_CATEGORY: dict[str, str] = {
    # READ — pure-information tools that don't touch the workspace
    "read_file":              "read",
    "list_files":             "read",
    "list_indexed_files":     "read",
    "repo_map":               "read",
    "get_ast_slice":          "read",
    "find_symbol":            "read",
    "symbol_search":          "read",
    "search_code":            "read",
    "grep_lines":             "read",
    "get_dependencies":       "read",
    "read_workitem":          "read",
    "read_repo_instructions": "read",
    # MUTATE — writes to the workspace
    "apply_patch":            "mutate",
    "replace_text":           "mutate",
    "replace_range":          "mutate",
    "write_file":             "mutate",
    "create_file":            "mutate",
    # RUN — verifier dispatch (runs commands against the workspace)
    "run_test":               "run",
    "run_command":            "run",
    "capture_test_baseline":  "run",
    # FINALIZE — git state mutations
    "finish_work_branch":     "finalize",
    "review_diff":            "finalize",
    # VERIFY_META — synthesizer / null-fallback for VERIFY phase
    "recommended_verification":  "verify_meta",
    "verification_unavailable":  "verify_meta",
    # ANALYZER — pure functions on stdout/stderr (workspace-independent)
    "detect_no_tests_ran":    "analyzer",
    "classify_push_error":    "analyzer",
}


# tool_policy enum → set of categories allowed.
# The mapping is structural — adding a category requires updating every
# tool_policy that should expose it. Story Intake (`NONE`) gets the
# empty set, so even the analyzer / verify_meta tools are stripped.
# That's intentional — Story Intake is no-tools-at-all by spec.
_TOOL_POLICY_CATEGORIES: dict[str, set[str]] = {
    "NONE":         set(),
    "READ_ONLY":    {"read", "verify_meta", "analyzer"},
    "VERIFICATION": {"read", "run", "verify_meta", "analyzer"},
    "MUTATION":     {"read", "mutate", "run", "finalize", "verify_meta", "analyzer"},
}


def categories_for_tool_policy(tool_policy: str | None) -> set[str] | None:
    """Resolve the allowed tool-category set for a `tool_policy` enum.

    Returns None when the input doesn't match a known policy — caller
    should interpret that as "no filter applied" (i.e. fall back to
    the seeded StagePolicy.phases[*].allowed_tools verbatim).
    """
    if not tool_policy:
        return None
    key = str(tool_policy).strip().upper().replace("-", "_")
    return _TOOL_POLICY_CATEGORIES.get(key)


def tool_passes_policy(tool_name: str, tool_policy: str | None) -> bool:
    """True when `tool_name`'s category is allowed under `tool_policy`.

    Unknown categories (tool not in TOOL_CATEGORY) are kept only when
    the policy is MUTATION (the "everything" tier) — that's the
    fail-safe direction: we'd rather expose a new tool we forgot to
    classify than silently strip something the agent needs in DEV stages.
    """
    cats = categories_for_tool_policy(tool_policy)
    if cats is None:
        return True   # no filter
    category = TOOL_CATEGORY.get(tool_name, "unknown")
    if category == "unknown":
        # Unknown tools only pass under MUTATION (full kit).
        return str(tool_policy).strip().upper() == "MUTATION"
    return category in cats


def schema_for_tool(tool_name: str) -> dict[str, Any]:
    """Look up the input schema for a tool. Falls back to the lenient
    `{type: "object"}` shape for unknown tools so dispatch isn't
    blocked when a new tool ships before this registry is updated.

    Returns a fresh dict each call so callers can mutate it without
    affecting the canonical constant.
    """
    schema = TOOL_INPUT_SCHEMAS.get(tool_name)
    if schema is None:
        return {"type": "object"}
    # Shallow copy — the schema dicts are small + structurally
    # immutable in practice, but defending against accidental
    # mutation in a caller is cheap.
    return {**schema}
