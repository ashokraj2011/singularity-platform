"""
M99 S1.1 — deterministic pre-ACT localization.

The "Centralize Agentic Coding Around Context Fabric" spec asks the
platform to localize the target files/symbols/tests BEFORE the model
edits, so the editor works against a compact target set instead of
re-deriving it from broad repo context every attempt. Pre-M99 the
localizers (repo_map / find_symbol / ast_search / code_context_package)
were agent-callable EXPLORE tools — useful, but the model had to choose
to call them and the result was never captured as a structured artifact.

This module mirrors verify_synthesis.synthesize_verifier_run: it runs a
fixed sequence of READ-ONLY localizer tools on the agent's behalf and
returns a LocalizationResult that the orchestrator persists as a
LocalizationReceipt and injects into the ACT prompt.

Contract (same as the auto-verifier):
  * NEVER raises. Every failure path returns a LocalizationResult with
    populated `sources`/`reason` so the caller keeps flowing.
  * System-initiated dispatch bypasses the policy gateway — localization
    IS stage intent ("understand before you edit"), and these are all
    read-only tools. Audit still fires upstream.
  * Gated by governed_automation.automation_enabled(policy, "localize")
    at the CALL SITE, which is OFF by default in Phase 0.

The localizers are best-effort and independent: a failure of any one
(tool missing, registry error) degrades that source to empty rather
than aborting the whole receipt — partial localization still helps.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .dispatch import ToolDispatchError, dispatch_tool

log = logging.getLogger(__name__)

# Read-only localizer tools, in dispatch order. repo_map orients; the
# symbol/AST search pins concrete targets; code_context_package gives the
# compact orientation markdown (and its package id for cross-referencing).
_LOCALIZER_TOOLS = ("repo_map", "find_symbol", "ast_search", "code_context_package")

_MAX_TARGETS = 50  # cap so a noisy repo_map can't bloat the receipt/prompt


def _as_str_list(value: Any) -> list[str]:
    """Coerce a tool result fragment into a clean list[str]."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, dict):
        # tolerate {path: ...} / {file: ...} / {name: ...} item shapes
        for k in ("path", "file", "name", "symbol", "qualified_name"):
            if isinstance(value.get(k), str) and value[k].strip():
                return [value[k]]
        return []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            out.extend(_as_str_list(item))
        return out
    return []


def _dedupe_cap(values: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for v in values:
        s = v.strip()
        if s and s not in seen:
            seen[s] = None
        if len(seen) >= _MAX_TARGETS:
            break
    return list(seen.keys())


@dataclass
class LocalizationResult:
    """Outcome of the localization sweep. Always populated.

    `sources` lists which localizer tools actually returned usable data,
    so the receipt records provenance. `reason` is set when nothing
    usable came back (every tool missing / errored).
    """

    target_files: list[str] = field(default_factory=list)
    target_symbols: list[str] = field(default_factory=list)
    target_tests: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    code_context_package_id: str | None = None
    summary: str | None = None
    reason: str | None = None

    @property
    def found_anything(self) -> bool:
        return bool(self.target_files or self.target_symbols or self.target_tests)

    def to_receipt_payload(self) -> dict[str, Any]:
        """Shape matching LocalizationReceipt fields (sans kind/created_at)."""
        return {
            "target_files": self.target_files,
            "target_symbols": self.target_symbols,
            "target_tests": self.target_tests,
            "queries": self.queries,
            "sources": self.sources,
            "code_context_package_id": self.code_context_package_id,
            "summary": self.summary,
            "origin": "platform",
        }


def _looks_like_test(path: str) -> bool:
    p = path.lower()
    return (
        "test" in p
        or p.endswith("_test.py")
        or p.endswith(".test.ts")
        or p.endswith(".spec.ts")
        or "/tests/" in p
        or "/test/" in p
    )


async def synthesize_localization(
    *,
    task_text: str | None,
    capability_id: str | None = None,
    queries: list[str] | None = None,
    work_item_id: str | None,
    workspace_id: str | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
) -> LocalizationResult:
    """Run the read-only localizer sweep. Never raises.

    Each localizer is dispatched independently; a per-tool failure is
    logged and skipped. The combined files/symbols/tests are deduped and
    capped. `queries` defaults to a single query derived from task_text.
    """
    result = LocalizationResult()
    base_queries = list(queries) if queries else []
    if not base_queries and task_text:
        base_queries = [task_text.strip()[:300]]
    result.queries = base_queries

    files: list[str] = []
    symbols: list[str] = []
    tests: list[str] = []

    for tool in _LOCALIZER_TOOLS:
        args = _args_for(tool, task_text, capability_id, base_queries)
        try:
            outcome = await dispatch_tool(
                tool,
                args,
                work_item_id=work_item_id,
                workspace_id=workspace_id,
                run_context=run_context,
                bearer=bearer,
            )
        except ToolDispatchError as exc:
            log.info("localization: %s dispatch failed (skipping): %s", tool, exc)
            continue
        if not outcome.tool_success:
            log.info("localization: %s reported failure (skipping)", tool)
            continue

        data = outcome.result if isinstance(outcome.result, dict) else {}
        result.sources.append(tool)

        if tool == "code_context_package":
            pkg_id = data.get("packageId") or data.get("package_id") or data.get("id")
            if isinstance(pkg_id, str) and pkg_id.strip():
                result.code_context_package_id = pkg_id.strip()

        # Files: common keys across the localizer tools.
        files.extend(_as_str_list(data.get("files")))
        files.extend(_as_str_list(data.get("paths")))
        files.extend(_as_str_list(data.get("matches")))
        files.extend(_as_str_list(data.get("results")))
        # Symbols.
        symbols.extend(_as_str_list(data.get("symbols")))
        symbols.extend(_as_str_list(data.get("definitions")))

    # Split tests out of the file set; keep both views.
    all_files = _dedupe_cap(files)
    result.target_files = [f for f in all_files if not _looks_like_test(f)]
    tests.extend([f for f in all_files if _looks_like_test(f)])
    result.target_tests = _dedupe_cap(tests)
    result.target_symbols = _dedupe_cap(symbols)

    if not result.found_anything:
        result.reason = (
            "no localizer returned usable targets"
            if not result.sources
            else "localizers ran but matched no files/symbols/tests"
        )
    else:
        result.summary = (
            f"localized {len(result.target_files)} file(s), "
            f"{len(result.target_symbols)} symbol(s), "
            f"{len(result.target_tests)} test(s) "
            f"via {', '.join(result.sources) or 'none'}"
        )
    return result


def _args_for(
    tool: str,
    task_text: str | None,
    capability_id: str | None,
    queries: list[str],
) -> dict[str, Any]:
    """Build per-tool args. Kept permissive — mcp-server validates shape
    and ignores unknown keys; we send the union of what each localizer
    plausibly accepts."""
    query = queries[0] if queries else (task_text or "")
    if tool == "repo_map":
        return {}
    if tool == "find_symbol":
        return {"query": query}
    if tool == "ast_search":
        return {"query": query}
    if tool == "code_context_package":
        args: dict[str, Any] = {"task_text": task_text or query}
        if capability_id:
            args["capability_id"] = capability_id
        return args
    return {}
