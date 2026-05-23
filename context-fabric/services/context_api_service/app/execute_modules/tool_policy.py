"""
M73 — tool inventory + normalisation.

Owns the LEGACY /execute path's tool list construction:

  - normalize_tool_for_mcp   — sanitise discover-tools responses
  - local_tool                — minimal helper for inline tool declarations
  - mandatory_local_tools_for_request — the role-keyed canonical inventory
  - merge_mandatory_local_tools       — union without duplicate names

The new context-fabric governed loop bypasses this entirely (tools come
from StagePhasePolicy.allowedTools in prompt-composer). This module
remains relevant for any caller still hitting POST /execute.

The role-keyed inventory composes from five blocks:

  base         — read + search + AST + filesystem fallback + repo_map.
                 Every code-touching stage gets these.
  research     — tighter subset for non-code stages (STORY_INTAKE,
                 PLAN, DESIGN). Strips path-enumeration tools because
                 those stages run at the platform root, not inside a
                 work-item checkout, so the agent can invent paths.
  verification — recommended_verification, run_test, run_command,
                 verification_unavailable, formal_verify. Both DEV
                 and QA see these.
  review       — review_diff (DEV pre-finish + QA inspection).
  mutation     — apply_patch / replace_text / replace_range / write_file
                 / git_commit / finish_work_branch. DEV ONLY.
"""
from __future__ import annotations

from typing import Any, Optional

from .stage_policy import classify_stage_role, stage_is_story_only

TOOL_EXECUTION_TARGETS = {"LOCAL", "SERVER"}
TOOL_RISK_LEVELS = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}


def normalize_tool_for_mcp(
    tool: dict[str, Any],
) -> tuple[Optional[dict[str, Any]], list[str]]:
    """Sanitise one tool descriptor returned by the tool-service discovery
    endpoint. Returns (tool|None, warnings)."""
    name = tool.get("tool_name") or tool.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, []

    warnings: list[str] = []
    clean_name = name.strip()
    raw_target = str(tool.get("execution_target") or "LOCAL").upper()
    execution_target = raw_target if raw_target in TOOL_EXECUTION_TARGETS else "SERVER"
    if execution_target != raw_target:
        warnings.append(
            f"tool {clean_name} returned unsupported execution_target {raw_target}; using SERVER"
        )

    raw_risk = str(tool.get("risk_level") or "low").upper()
    risk_level = raw_risk if raw_risk in TOOL_RISK_LEVELS else "LOW"
    if risk_level != raw_risk:
        warnings.append(
            f"tool {clean_name} returned unsupported risk_level {raw_risk}; using LOW"
        )

    input_schema = tool.get("input_schema")
    if not isinstance(input_schema, dict):
        input_schema = {"type": "object"}

    return {
        "name": clean_name,
        "description": tool.get("description", ""),
        "input_schema": input_schema,
        "execution_target": execution_target,
        "requires_approval": bool(tool.get("requires_approval", False)),
        "risk_level": risk_level,
    }, warnings


def local_tool(
    name: str,
    description: str,
    input_schema: dict[str, Any],
    risk_level: str = "LOW",
    requires_approval: bool = False,
) -> dict[str, Any]:
    """Build a LOCAL-target tool descriptor for the inline inventory below."""
    return {
        "name": name,
        "description": description,
        "input_schema": input_schema,
        "execution_target": "LOCAL",
        "requires_approval": requires_approval,
        "risk_level": risk_level,
    }


def mandatory_local_tools_for_request(req: Any) -> list[dict[str, Any]]:
    """Canonical tool inventory for a stage.

    DEV stages get mutation; QA stages get inspection + verification only;
    non-code stages get the grounding subset.

    Body left verbatim from the previous execute.py inline definition —
    the inventory will evolve, but the dispatch shape doesn't.
    """
    if stage_is_story_only(req):
        return []

    is_dev, is_qa = classify_stage_role(req)

    # ── base: every stage gets these (PLAN, DESIGN, DEV, QA, etc.) ──
    base = [
        local_tool("read_file", "Read a sandbox-relative file.", {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        }),
        local_tool("search_code", "Search code in the MCP sandbox with ripgrep.", {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "path": {"type": "string"},
                "max_results": {"type": "number"},
            },
            "required": ["query"],
        }),
        local_tool("index_workspace", "Index the active workspace for symbol lookup.", {"type": "object", "properties": {}}),
        local_tool("find_symbol", "Find symbols in the active workspace.", {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }),
        local_tool("get_symbol", "Fetch one indexed symbol's body by id or name (cheaper than read_file for known functions/classes).", {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "name": {"type": "string"},
            },
        }),
        local_tool("get_ast_slice", "Fetch a slice of file content by symbol id OR explicit line range (most token-efficient code read).", {
            "type": "object",
            "properties": {
                "symbolId": {"type": "string"},
                "name": {"type": "string"},
                "filePath": {"type": "string"},
                "startLine": {"type": "number"},
                "endLine": {"type": "number"},
                "maxBytes": {"type": "number"},
            },
        }),
        local_tool("get_dependencies", "List imports / exports / call-sites for a given indexed file.", {
            "type": "object",
            "properties": {"filePath": {"type": "string"}},
            "required": ["filePath"],
        }),
        local_tool("list_directory", "Sandbox-scoped directory listing.", {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "recursive": {"type": "boolean"},
            },
        }),
        local_tool("list_indexed_files", "Enumerate files in the AST index (path + language + size). Preferred over find_files for code lookups.", {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "language": {"type": "string"},
                "limit": {"type": "number"},
            },
        }),
        local_tool("find_files", "Locate files by glob pattern (filesystem fallback when AST index doesn't help).", {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "max_results": {"type": "number"},
            },
            "required": ["pattern"],
        }),
        local_tool("file_stats", "Bytes + lines + language for non-indexed files.", {
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
            },
        }),
        local_tool("grep_lines", "Ripgrep search with N lines of context before/after each match.", {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "path": {"type": "string"},
                "context_before": {"type": "number"},
                "context_after": {"type": "number"},
                "regex": {"type": "boolean"},
                "glob": {"type": "string"},
            },
            "required": ["query"],
        }),
        local_tool("repo_map", "Compact repo topology: build system, languages, entrypoints, test dirs, verifier inventory.", {
            "type": "object",
            "properties": {"max_directories": {"type": "number"}},
        }),
    ]

    if not (is_dev or is_qa):
        # M55 — Non-code stages get a tighter research-only subset.
        research_only_names = {
            "read_file",
            "search_code",
            "index_workspace",
            "find_symbol",
            "get_symbol",
            "repo_map",
        }
        return [t for t in base if t.get("name") in research_only_names]

    verification = [
        local_tool("recommended_verification", "Ranked, allowlist-checked verifier recommendations from the verifier-registry. Use at VERIFY entry to pick the right run_test invocation deterministically.", {
            "type": "object",
            "properties": {
                "changed_paths": {"type": "array", "items": {"type": "string"}},
            },
        }),
        local_tool("run_test", "Run an allowlisted test, lint, typecheck, or verification command.", {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}},
                "cwd": {"type": "string"},
                "timeout_ms": {"type": "number"},
            },
            "required": ["command"],
        }, risk_level="MEDIUM"),
        local_tool("run_command", "Run an allowlisted non-shell command in the MCP sandbox.", {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}},
                "cwd": {"type": "string"},
                "timeout_ms": {"type": "number"},
            },
            "required": ["command"],
        }, risk_level="MEDIUM"),
        local_tool("verification_unavailable", "Record an explicit verification-unavailable receipt when no runnable command exists.", {
            "type": "object",
            "properties": {
                "reason": {"type": "string"},
                "inspected": {"type": "array", "items": {"type": "string"}},
                "attemptedCommands": {"type": "array", "items": {"type": "string"}},
                "paths_context": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["reason"],
        }, risk_level="LOW"),
        local_tool("formal_verify", "Run a formal verification query and return a solver receipt.", {
            "type": "object",
            "properties": {
                "scope": {"type": "string"},
                "facts": {"type": "object"},
                "constraints": {"type": "array", "items": {"type": "object"}},
                "query": {"type": "object"},
                "artifactRefs": {"type": "array", "items": {"type": "object"}},
                "timeoutMs": {"type": "number"},
            },
            "required": ["scope", "facts", "query"],
        }, risk_level="MEDIUM"),
    ]

    review = [
        local_tool("review_diff", "Pre-finish diff review: classification, test-coverage heuristic, verification-coverage intersection, risks punch list.", {
            "type": "object",
            "properties": {},
        }),
    ]

    mutation = [
        local_tool("apply_patch", "Apply a unified diff patch inside the MCP sandbox.", {
            "type": "object",
            "properties": {"patch": {"type": "string"}},
            "required": ["patch"],
        }, risk_level="MEDIUM"),
        local_tool("replace_text", "Replace exact anchor text inside an existing MCP sandbox file.", {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "oldText": {"type": "string"},
                "newText": {"type": "string"},
                "occurrence": {"oneOf": [{"type": "string", "enum": ["first", "all"]}, {"type": "number"}]},
            },
            "required": ["path", "oldText", "newText"],
        }, risk_level="MEDIUM"),
        local_tool("replace_range", "Replace an inclusive 1-based line range inside an existing MCP sandbox file.", {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "startLine": {"type": "number"},
                "endLine": {"type": "number"},
                "replacement": {"type": "string"},
            },
            "required": ["path", "startLine", "endLine", "replacement"],
        }, risk_level="MEDIUM"),
        local_tool("write_file", "Create or overwrite a complete file body. Reserve for NEW files; use apply_patch / replace_text / replace_range for existing files.", {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "forceFullReplace": {"type": "boolean"},
            },
            "required": ["path", "content"],
        }, risk_level="MEDIUM"),
        local_tool("git_commit", "Commit sandbox changes with a message. Prefer finish_work_branch for workflow completion.", {
            "type": "object",
            "properties": {"message": {"type": "string"}, "author": {"type": "string"}},
            "required": ["message"],
        }, risk_level="MEDIUM"),
        local_tool("finish_work_branch", "Finish the prepared work branch and return git evidence (preferred workflow completion).", {
            "type": "object",
            "properties": {"commitMessage": {"type": "string"}},
        }, risk_level="MEDIUM"),
    ]

    if is_dev:
        return base + verification + review + mutation
    # QA: read-only inspection + verification + review, NO mutation
    return base + verification + review


def merge_mandatory_local_tools(
    tools: list[dict[str, Any]],
    req: Any,
) -> list[dict[str, Any]]:
    """Union the discovered tools with the mandatory inventory. Discovered
    tools win on name collisions (caller-defined > inventory default)."""
    seen = {str(tool.get("name")) for tool in tools if tool.get("name")}
    merged = list(tools)
    for tool in mandatory_local_tools_for_request(req):
        if tool["name"] not in seen:
            merged.append(tool)
            seen.add(tool["name"])
    return merged
