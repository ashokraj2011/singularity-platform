# @agentandtools/tool-registry

Canonical tool schemas + categories. Source-of-truth for what tools exist, what they accept, and which `tool_policy` exposes them.

## What lives here

- `src/tools.json` — the canonical manifest. Every tool the platform's governed loop can dispatch is listed here with its category and JSON-Schema input shape.
- `src/index.ts` — typed loader + helper functions (`getToolDescriptor`, `listTools`, `toolsByCategory`, `effectiveToolsForPolicy`).

## Source-of-truth contract

When a new tool ships:

1. Add a `"<tool_name>"` entry to `src/tools.json` with its `category` and `input_schema`.
2. Mirror the same entry in `context-fabric/services/context_api_service/app/governed/tool_schemas.py` (`TOOL_INPUT_SCHEMAS` + `TOOL_CATEGORY` dicts).
3. Implement the tool in `mcp-server/src/tools/*.ts` (descriptor + execute).

Step 2 is duplicate but intentional today — CF reads the Python dict at module-load to avoid a JSON read on every turn build. A CI drift check is on the roadmap (M91.B+); for now, treat `src/tools.json` as authoritative when the two disagree.

## Categories

| Category | Meaning | Allowed under |
|---|---|---|
| `read` | Pure information (read_file, list_files, find_symbol, etc.) | READ_ONLY, VERIFICATION, MUTATION |
| `mutate` | Writes to the workspace (apply_patch, replace_text, write_file) | MUTATION |
| `run` | Runs a command against the workspace (run_test, run_command) | VERIFICATION, MUTATION |
| `finalize` | Git-state mutations (finish_work_branch, review_diff) | MUTATION |
| `verify_meta` | Synthesizer / null-fallback (recommended_verification, verification_unavailable) | READ_ONLY, VERIFICATION, MUTATION |
| `analyzer` | Pure functions on stdout/stderr (detect_no_tests_ran, classify_push_error) | READ_ONLY, VERIFICATION, MUTATION |

The mapping from `tool_policy` → category set is mirrored on the CF side (`tool_schemas.py:_TOOL_POLICY_CATEGORIES`); change both together.

## Wire surface

`workgraph-api` exposes `GET /api/tool-registry` returning the manifest. The workflow designer (M91.C) uses this to render the effective-policy preview pane.
