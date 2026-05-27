/**
 * M91.B — Canonical tool registry, source-of-truth for tool schemas.
 *
 * Pre-M91.B, tool schemas lived in three places that drifted:
 *   1. mcp-server/src/tools/* — descriptor + execute() per tool
 *   2. context-fabric/.../tool_schemas.py — TOOL_INPUT_SCHEMAS dict
 *      and TOOL_CATEGORY classification (M90.E)
 *   3. workflow designer (workgraph-web) — no schema awareness; the
 *      tool picker was a free-text list
 *
 * This package establishes ONE canonical source: src/tools.json. CF
 * still ships its tool_schemas.py for runtime convenience (no JSON
 * read on every turn build), but the JSON is the contract that the
 * Python side must mirror — drift checks belong in CI.
 *
 * Consumers:
 *   - workgraph-web's NodeInspector (M91.C) reads via the workgraph-api
 *     manifest endpoint
 *   - workgraph-api serves the JSON at GET /api/tool-registry so the
 *     web app doesn't bundle it directly (single-source over the wire)
 *   - mcp-server can adopt it incrementally to validate args against
 *     the canonical schema before dispatch
 *
 * Schema:
 *   {
 *     "tools": {
 *       "<tool_name>": {
 *         "category": "read" | "mutate" | "run" | "finalize"
 *                   | "verify_meta" | "analyzer",
 *         "input_schema": <JSON Schema input shape>
 *       },
 *       ...
 *     }
 *   }
 *
 * Categories drive the M91.A tool_policy filter:
 *   NONE         → none
 *   READ_ONLY    → read, verify_meta, analyzer
 *   VERIFICATION → read, run, verify_meta, analyzer
 *   MUTATION     → read, mutate, run, finalize, verify_meta, analyzer
 *
 * If you add a new tool, add it to BOTH src/tools.json AND
 * context-fabric/.../tool_schemas.py. A unit test that diff-checks
 * the two is on the roadmap.
 */

// `as const` works at module load via the JSON import (resolveJsonModule).
import toolsJson from "./tools.json"

export type ToolCategory =
  | "read"
  | "mutate"
  | "run"
  | "finalize"
  | "verify_meta"
  | "analyzer"

export interface ToolDescriptor {
  /** Categorisation used by tool_policy filters. */
  category: ToolCategory | string
  /** JSON Schema shape for the tool's args. */
  input_schema: Record<string, unknown>
}

export interface ToolRegistryManifest {
  /** Schema-evolution token. Bump when the manifest shape changes. */
  version?: number
  tools: Record<string, ToolDescriptor>
}

/**
 * The canonical manifest as an immutable object. Consumers receive a
 * shallow-frozen view to discourage accidental mutation; the JSON
 * file itself is the only place to make changes.
 */
export const TOOL_REGISTRY: ToolRegistryManifest = Object.freeze({
  ...toolsJson,
  tools: Object.freeze({ ...(toolsJson as ToolRegistryManifest).tools }) as Record<string, ToolDescriptor>,
}) as ToolRegistryManifest

/** Look up one tool. Returns undefined for unknown names. */
export function getToolDescriptor(name: string): ToolDescriptor | undefined {
  return TOOL_REGISTRY.tools[name]
}

/** Enumerate all known tools sorted alphabetically (UI-friendly). */
export function listTools(): string[] {
  return Object.keys(TOOL_REGISTRY.tools).sort()
}

/** Filter tools by category — useful for tool-picker UIs. */
export function toolsByCategory(category: string): string[] {
  return listTools().filter(
    (n) => TOOL_REGISTRY.tools[n]?.category === category,
  )
}

// ────────────────────────────────────────────────────────────────────
// M91.A tool_policy → category set. Mirrors the CF-side
// _TOOL_POLICY_CATEGORIES so the designer can preview the same
// filter the runtime will apply without round-tripping to CF.
// ────────────────────────────────────────────────────────────────────
const TOOL_POLICY_CATEGORIES: Record<string, Set<string>> = {
  NONE: new Set<string>(),
  READ_ONLY: new Set(["read", "verify_meta", "analyzer"]),
  VERIFICATION: new Set(["read", "run", "verify_meta", "analyzer"]),
  MUTATION: new Set([
    "read",
    "mutate",
    "run",
    "finalize",
    "verify_meta",
    "analyzer",
  ]),
}

/**
 * Compute the effective tool list for a given tool_policy by
 * intersecting the registry with the policy's allowed categories.
 * Mirrors stage_execution_policy.py:_filter_phase_tools but driven
 * from the canonical registry rather than per-phase seeds.
 *
 * For the designer preview pane (M91.C): pass the operator-chosen
 * policy and render the resulting tool list as "this is what the
 * agent will see at runtime."
 */
export function effectiveToolsForPolicy(toolPolicy: string | undefined): string[] {
  if (!toolPolicy) return listTools()
  const key = toolPolicy.toUpperCase().replace(/-/g, "_")
  const cats = TOOL_POLICY_CATEGORIES[key]
  if (!cats) return listTools()
  return listTools().filter((n) => cats.has(TOOL_REGISTRY.tools[n]?.category ?? ""))
}
