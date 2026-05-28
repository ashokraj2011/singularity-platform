/**
 * M91.D — mcp-server consumption of the canonical tool registry.
 *
 * Pre-M91.D, mcp-server's tool-run.ts had a hand-maintained allowlist
 * of "workspace-independent" tools (the four tools that can run
 * against an empty sandbox: parsers, classifiers, synthesizers). When
 * a new such tool shipped, you had to remember to add it there. The
 * canonical tools.json already carries this information via the
 * `category` field (analyzer + verify_meta are the workspace-
 * independent categories), so this module derives the allowlist from
 * the JSON rather than hand-maintaining it.
 *
 * Scope note: we deliberately do NOT replace mcp-server's per-tool
 * `input_schema` declarations with the canonical JSON. Reason: mcp-
 * server's schemas are RICHER than the LLM-facing canonical schema
 * (e.g. apply_patch carries `expected_hashes` + `expected_absent_paths`
 * for executor-side optimistic concurrency that CF doesn't expose).
 * The two schemas describe different things: mcp-server's = what the
 * executor accepts; canonical = what the LLM is allowed to pass.
 * Drift between them is fine as long as mcp-server's is a superset
 * of canonical's required fields — M91.F covers the drift check.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import manifest from './tools-registry.json'

interface ToolDescriptor {
  category: string
  input_schema: Record<string, unknown>
}
interface ToolRegistryManifest {
  version?: number
  tools: Record<string, ToolDescriptor>
}

const TOOL_REGISTRY: ToolRegistryManifest = manifest as unknown as ToolRegistryManifest

// Categories that don't touch the workspace. Used to derive the
// workspace-independent allowlist below — the M90.C "selective fail-
// fast" guard in tool-run.ts uses this to decide whether to refuse a
// tool dispatch when source-materializer failed.
const WORKSPACE_INDEPENDENT_CATEGORIES = new Set(['analyzer', 'verify_meta'])

/**
 * Returns the set of tool names that the source-materializer can fail
 * for WITHOUT refusing the tool dispatch. Derived from the canonical
 * tool-registry: a tool is workspace-independent iff its category is
 * `analyzer` (pure stdout/stderr parser) or `verify_meta` (synthesizer
 * / null-fallback). Replaces the previous hand-maintained Set in
 * tool-run.ts so new tools in those categories pick up the right
 * behavior automatically.
 */
export function workspaceIndependentTools(): Set<string> {
  const out = new Set<string>()
  for (const [name, desc] of Object.entries(TOOL_REGISTRY.tools)) {
    if (WORKSPACE_INDEPENDENT_CATEGORIES.has(desc.category)) {
      out.add(name)
    }
  }
  return out
}

/** Look up a tool's category. Returns 'unknown' when the tool isn't
 *  in the registry — that's the conservative default the M90.C
 *  workspace check expects (unknown → requires workspace). */
export function categoryForTool(name: string): string {
  return TOOL_REGISTRY.tools[name]?.category ?? 'unknown'
}

/** Whole-manifest accessor for downstream consumers (drift check,
 *  future tool-picker, etc.). Returns the parsed JSON unmodified. */
export function toolRegistryManifest(): ToolRegistryManifest {
  return TOOL_REGISTRY
}
