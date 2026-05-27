"""
M90.E + M91.E — Per-tool input schemas + categorisation.

M90.E (2026-05-27) added real per-tool input schemas so the LLM gets
shape information instead of a bare `{type: "object"}` for every tool.
M91.E (2026-05-27) refactored the dict literals out into the shared
canonical JSON manifest (`tools.json` in this dir, mirrored from
agent-and-tools/packages/tool-registry/src/tools.json).

Why JSON-as-source: previously the schemas + categories were hand-
authored Python dicts and the JSON manifest workgraph-api ships was
a derivative. Three places held the same data (Python here, the
shared package, workgraph-api's mirror) and could drift independently.
Now CF reads `tools.json` at import time → that file IS the contract.
The shared package + workgraph-api mirror are byte-identical copies
(see M91.F drift check).

Architectural note: cache stability (M72A) is preserved because the
JSON is loaded ONCE at module import and produces module-constants.
_build_tool_descriptors in turn.py still gets a stable view → provider
prompt caches stay warm. The shift is purely structural — the same
26 tools, same categories, same schemas — just sourced from JSON.

If a tool isn't listed in tools.json, `schema_for_tool` falls back to
the lenient `{type: "object"}` shape so dispatch isn't blocked when
a new tool ships before the registry is updated.

Adding a new tool:
  1. Edit `agent-and-tools/packages/tool-registry/src/tools.json`
     (the canonical source).
  2. Mirror to this file (`tools.json` next to this module) AND to
     `workgraph-studio/apps/api/src/modules/tool-registry/tools.json`.
  3. M91.F drift check will fail if you forget a mirror.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


# Load the manifest at module import. The file lives next to this
# module so the package is fully self-contained (no path-tricks
# reaching out of the service tree).
_MANIFEST_PATH = Path(__file__).parent / "tools.json"


def _load_manifest() -> dict[str, Any]:
    """Read tools.json once at module init. On any failure, return an
    empty manifest so the loop keeps working with the bare-object
    fallback — the LLM loses shape hints but dispatch never breaks.
    """
    try:
        with _MANIFEST_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or not isinstance(data.get("tools"), dict):
            log.warning(
                "tool_schemas: %s is missing top-level `tools` dict; using empty manifest",
                _MANIFEST_PATH,
            )
            return {"tools": {}}
        return data
    except FileNotFoundError:
        log.warning("tool_schemas: %s not found; using empty manifest", _MANIFEST_PATH)
        return {"tools": {}}
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("tool_schemas: failed to load %s: %s", _MANIFEST_PATH, exc)
        return {"tools": {}}


_MANIFEST = _load_manifest()


# Public dicts — kept as module constants so existing call sites
# (turn.py and tests) keep working unchanged. Derived from the JSON
# manifest at import time, so they're effectively read-only.
TOOL_INPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    name: dict(entry.get("input_schema") or {})
    for name, entry in _MANIFEST.get("tools", {}).items()
    if isinstance(entry, dict)
}

TOOL_CATEGORY: dict[str, str] = {
    name: str(entry.get("category", "unknown"))
    for name, entry in _MANIFEST.get("tools", {}).items()
    if isinstance(entry, dict)
}


# tool_policy enum → set of categories allowed. Kept Python-side
# (mirrored on the workgraph-api / web sides) — this is the runtime
# semantics, not the manifest. Update both sides together; M91.F
# drift check covers the JSON manifest, not these.
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
