#!/usr/bin/env python3
"""
M91.F — Drift check across all four mirrors of the canonical tool registry.

The canonical tool manifest (`agent-and-tools/packages/tool-registry/src/tools.json`)
is duplicated into three other services because the Docker build contexts
of those services don't extend across the agent-and-tools/ tree:

  1. agent-and-tools/packages/tool-registry/src/tools.json  ← canonical
  2. context-fabric/services/context_api_service/app/governed/tools.json
  3. workgraph-studio/apps/api/src/modules/tool-registry/tools.json
  4. mcp-server/src/tools/tools-registry.json

When you add or change a tool, you MUST update all four. This script
compares them all and fails (exit 1) if any have drifted, printing the
diff so the operator can see what needs to land.

Usage:
  bin/check-tool-registry-drift.py             # quiet on success
  bin/check-tool-registry-drift.py --verbose   # always shows summary

CI integration: add a GitHub Actions step that runs this; PRs fail if
someone updates one mirror and forgets the others.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


# Resolved relative to the repo root (this script's parent's parent).
_REPO_ROOT = Path(__file__).resolve().parent.parent

# (label, path) tuples. The canonical mirror comes first by convention
# so diffs are reported as "X drifts from canonical."
_MIRRORS = [
    ("canonical (agent-and-tools)", _REPO_ROOT / "agent-and-tools/packages/tool-registry/src/tools.json"),
    ("context-fabric",              _REPO_ROOT / "context-fabric/services/context_api_service/app/governed/tools.json"),
    ("workgraph-api",               _REPO_ROOT / "workgraph-studio/apps/api/src/modules/tool-registry/tools.json"),
    ("mcp-server",                  _REPO_ROOT / "mcp-server/src/tools/tools-registry.json"),
]


def _load(path: Path) -> dict:
    """Read JSON, raising a friendly error on missing file."""
    if not path.exists():
        raise FileNotFoundError(
            f"Tool-registry mirror missing: {path}\n"
            "  Has a service been removed? If intentional, edit "
            "bin/check-tool-registry-drift.py:_MIRRORS to drop the entry."
        )
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _canonical_hash(data: dict) -> str:
    """Hash the JSON in a canonical form (sorted keys, no whitespace
    variance). Lets us tolerate formatting differences across mirrors
    while still catching real content drift."""
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _diff_summary(canonical: dict, other: dict) -> list[str]:
    """Build a human-readable diff between two manifests.

    Reports per-tool: missing-from-other, extra-in-other, and
    category/schema changes. Caps schema-diff verbosity since one
    field change can produce a wall of nested JSON; we just say
    'differs' and let the operator open both files for detail.
    """
    out: list[str] = []
    c_tools = canonical.get("tools", {})
    o_tools = other.get("tools", {})
    c_names = set(c_tools.keys())
    o_names = set(o_tools.keys())
    missing = sorted(c_names - o_names)
    extra = sorted(o_names - c_names)
    if missing:
        out.append(f"  MISSING from this mirror: {missing}")
    if extra:
        out.append(f"  EXTRA in this mirror (not in canonical): {extra}")
    for name in sorted(c_names & o_names):
        c_entry = c_tools[name]
        o_entry = o_tools[name]
        if c_entry.get("category") != o_entry.get("category"):
            out.append(
                f"  {name}: category differs "
                f"(canonical={c_entry.get('category')!r}, this={o_entry.get('category')!r})"
            )
        if c_entry.get("input_schema") != o_entry.get("input_schema"):
            out.append(f"  {name}: input_schema differs (run a JSON diff to compare)")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verbose", action="store_true",
                        help="Print success summary even when all mirrors agree.")
    args = parser.parse_args()

    # Load everything.
    loaded: list[tuple[str, Path, dict, str]] = []
    for label, path in _MIRRORS:
        try:
            data = _load(path)
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            print(f"ERROR loading {label} ({path}): {exc}", file=sys.stderr)
            return 1
        h = _canonical_hash(data)
        loaded.append((label, path, data, h))

    canonical_label, canonical_path, canonical_data, canonical_hash = loaded[0]
    drifted: list[tuple[str, Path, dict, str]] = [
        entry for entry in loaded[1:] if entry[3] != canonical_hash
    ]

    if not drifted:
        if args.verbose:
            tool_count = len(canonical_data.get("tools", {}))
            print(f"OK — all {len(loaded)} tool-registry mirrors agree ({tool_count} tools, hash={canonical_hash[:12]}…).")
        return 0

    # Drift detected — fail loud.
    print(f"DRIFT — {len(drifted)} mirror(s) differ from canonical ({canonical_path}):", file=sys.stderr)
    print(f"  canonical hash: {canonical_hash}", file=sys.stderr)
    for label, path, data, h in drifted:
        print(f"\n  {label} ({path})", file=sys.stderr)
        print(f"    hash: {h}", file=sys.stderr)
        diffs = _diff_summary(canonical_data, data)
        for line in diffs[:20]:  # cap so a wholesale rewrite doesn't blow stderr
            print(line, file=sys.stderr)
        if len(diffs) > 20:
            print(f"  ... and {len(diffs) - 20} more difference(s)", file=sys.stderr)

    print(
        "\nTo fix: edit the canonical manifest "
        f"({canonical_path.relative_to(_REPO_ROOT)}), then copy it to each "
        "drifted mirror. See agent-and-tools/packages/tool-registry/README.md "
        "for the source-of-truth contract.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
