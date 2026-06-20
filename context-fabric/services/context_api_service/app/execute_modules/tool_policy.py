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
TOOL_CAPABILITY_PERMISSIONS = {"read", "invoke", "configure", "edit"}
TOOL_SOURCES = {"local", "provider", "runtime", "provider_manifest", "url_document", "uploaded_document"}


def _first_string(tool: dict[str, Any], *keys: str) -> Optional[str]:
    for key in keys:
        value = tool.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _capability_permissions(tool: dict[str, Any]) -> list[str]:
    raw = (
        tool.get("capability_permissions")
        or tool.get("capabilityPermissions")
        or tool.get("permissions")
        or ["read", "invoke"]
    )
    if isinstance(raw, dict):
        raw = [name for name, enabled in raw.items() if enabled]
    if not isinstance(raw, list):
        raw = ["read", "invoke"]

    permissions: list[str] = []
    for item in raw:
        value = str(item).strip().lower()
        if value in TOOL_CAPABILITY_PERMISSIONS and value not in permissions:
            permissions.append(value)
    return permissions or ["read", "invoke"]


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

    permissions = _capability_permissions(tool)
    provider_id = _first_string(tool, "provider_id", "providerId")
    provider_manifest_version = (
        _first_string(tool, "provider_manifest_version", "providerManifestVersion", "manifest_version", "manifestVersion")
    )
    provider_manifest_digest = (
        _first_string(tool, "provider_manifest_digest", "providerManifestDigest", "manifest_digest", "manifestDigest")
    )
    provider_manifest_signature_key_id = (
        _first_string(
            tool,
            "provider_manifest_signature_key_id",
            "providerManifestSignatureKeyId",
            "signature_key_id",
            "signatureKeyId",
        )
    )
    source = str(_first_string(tool, "source") or ("provider" if provider_id else "local")).lower()
    if source not in TOOL_SOURCES:
        source = "runtime"
    source_type = _first_string(tool, "source_type", "sourceType") or ("provider_manifest" if source == "provider" else source)
    source_ref = _first_string(tool, "source_ref", "sourceRef", "manifest_url", "manifestUrl")
    provider_locked = bool(tool.get("provider_locked") or tool.get("providerLocked"))

    return {
        "name": clean_name,
        "description": tool.get("description", ""),
        "input_schema": input_schema,
        "execution_target": execution_target,
        "requires_approval": bool(tool.get("requires_approval", False)),
        "risk_level": risk_level,
        "capability_id": tool.get("capability_id") or tool.get("capabilityId"),
        "capability_permissions": permissions,
        "read_only": bool(tool.get("read_only") or tool.get("readOnly") or ("edit" not in permissions and "configure" not in permissions)),
        "provider_locked": provider_locked,
        "provider_id": provider_id,
        "provider_manifest_version": provider_manifest_version,
        "provider_manifest_digest": provider_manifest_digest,
        "provider_manifest_signature_key_id": provider_manifest_signature_key_id,
        "provider_manifest_signed": tool.get("provider_manifest_signed")
        if isinstance(tool.get("provider_manifest_signed"), bool)
        else tool.get("providerManifestSigned")
        if isinstance(tool.get("providerManifestSigned"), bool)
        else None,
        "source_type": source_type,
        "source_ref": source_ref,
        "source": source,
    }, warnings


def local_tool(
    name: str,
    description: str,
    input_schema: dict[str, Any],
    risk_level: str = "LOW",
    requires_approval: bool = False,
) -> dict[str, Any]:
    """Build a LOCAL-target tool descriptor for the inline inventory below."""
    mutation_tools = {
        "apply_patch", "replace_text", "replace_range", "write_file",
        "git_commit", "finish_work_branch",
    }
    permissions = ["read", "invoke", "edit"] if name in mutation_tools else ["read", "invoke"]
    return {
        "name": name,
        "description": description,
        "input_schema": input_schema,
        "execution_target": "LOCAL",
        "requires_approval": requires_approval,
        "risk_level": risk_level,
        "capability_permissions": permissions,
        "read_only": "edit" not in permissions and "configure" not in permissions,
        "source": "local",
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


def _permission_values(raw: Any) -> list[str]:
    if isinstance(raw, dict):
        raw = [name for name, enabled in raw.items() if enabled]
    if not isinstance(raw, list):
        return []

    permissions: list[str] = []
    for item in raw:
        value = str(item).strip().lower()
        if value in TOOL_CAPABILITY_PERMISSIONS and value not in permissions:
            permissions.append(value)
    return permissions


def _effective_capability_names(capability: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for key in ("id", "name", "skillName", "skill_name", "toolName", "tool_name"):
        value = capability.get(key)
        if isinstance(value, str) and value.strip():
            names.add(value.strip())
    return names


def _tool_capability_names(tool: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for key in ("capability_id", "capabilityId", "name", "tool_name", "toolName"):
        value = tool.get(key)
        if isinstance(value, str) and value.strip():
            names.add(value.strip())
    return names


def effective_capability_allows_tool(
    tool: dict[str, Any],
    effective_capabilities: list[dict[str, Any]],
    *,
    permission: str = "invoke",
    require_effective_capabilities: bool = False,
) -> tuple[bool, str]:
    """Return whether a tool is allowed by the effective profile set."""
    capabilities = [
        capability for capability in effective_capabilities
        if isinstance(capability, dict)
    ]
    if not capabilities:
        if require_effective_capabilities:
            return False, "effective capability set required"
        return True, ""

    requested_permission = str(permission).strip().lower()
    if requested_permission not in TOOL_CAPABILITY_PERMISSIONS:
        return False, f"unsupported permission {requested_permission}"

    capability_index: dict[str, dict[str, Any]] = {}
    for capability in capabilities:
        for name in _effective_capability_names(capability):
            capability_index[name] = capability

    tool_names = _tool_capability_names(tool)
    matched_name = next((name for name in tool_names if name in capability_index), None)
    if not matched_name:
        return False, "no matching capability"

    permissions = _permission_values(capability_index[matched_name].get("permissions"))
    if requested_permission not in permissions:
        return False, f"missing {requested_permission}"

    return True, ""


def filter_tools_by_effective_capabilities(
    tools: list[dict[str, Any]],
    effective_capabilities: list[dict[str, Any]],
    *,
    require_effective_capabilities: bool = False,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Apply the resolved Agent Profile capability set to MCP tools.

    Empty capability sets preserve legacy behavior only when no agent profile is
    in play. Once a caller declares a profile-backed run, the set is
    authoritative even when empty; no tool may be exposed until resolution
    yields a capability that grants invoke.
    """
    capabilities = [
        capability for capability in effective_capabilities
        if isinstance(capability, dict)
    ]
    if not capabilities:
        if require_effective_capabilities:
            return [], [
                "all tools hidden: effective capability set is required for this agent profile run"
            ]
        return tools, []

    filtered: list[dict[str, Any]] = []
    warnings: list[str] = []
    for tool in tools:
        allowed, reason = effective_capability_allows_tool(
            tool,
            capabilities,
            require_effective_capabilities=require_effective_capabilities,
        )
        if not allowed:
            display_name = str(tool.get("name") or tool.get("tool_name") or "unknown")
            warnings.append(f"tool {display_name} hidden by effective capability set: {reason}")
            continue

        filtered.append(tool)

    return filtered, warnings
