/**
 * M91.B — Tool registry HTTP surface.
 *
 * Serves the canonical tool manifest so the workflow designer (M91.C)
 * can render an "effective runtime policy" preview without bundling
 * the JSON into the SPA. Single source flows: registry package →
 * workgraph-api → designer.
 *
 * On the canonical source: the OFFICIAL home of the manifest lives at
 * `agent-and-tools/packages/tool-registry/src/tools.json` — that's
 * the file you edit when adding/changing a tool. This service ships
 * a MIRROR of that file (./tools.json) because the workgraph-studio
 * Docker build context doesn't extend into agent-and-tools. CF
 * (context-fabric/.../tool_schemas.py) is a third mirror, by the same
 * argument. A CI drift check is on the roadmap.
 *
 * Read-only. Standard authMiddleware in app.ts gates access; the
 * registry is not sensitive — operators inspecting the workflow
 * designer already have a session.
 */
import { Router } from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
import manifest from './tools.json'

interface ToolDescriptor {
  category: string
  input_schema: Record<string, unknown>
}
interface ToolRegistryManifest {
  version?: number
  tools: Record<string, ToolDescriptor>
}
const TOOL_REGISTRY: ToolRegistryManifest = manifest as unknown as ToolRegistryManifest

// M91.A tool_policy → category set. Mirrors the CF-side
// _TOOL_POLICY_CATEGORIES so the designer's preview matches CF's
// runtime behavior. Update both when this changes.
const TOOL_POLICY_CATEGORIES: Record<string, Set<string>> = {
  NONE: new Set<string>(),
  READ_ONLY: new Set(['read', 'verify_meta', 'analyzer']),
  VERIFICATION: new Set(['read', 'run', 'verify_meta', 'analyzer']),
  MUTATION: new Set(['read', 'mutate', 'run', 'finalize', 'verify_meta', 'analyzer']),
}

function listTools(): string[] {
  return Object.keys(TOOL_REGISTRY.tools).sort()
}

function effectiveToolsForPolicy(toolPolicy: string | undefined): string[] {
  if (!toolPolicy) return listTools()
  const key = toolPolicy.toUpperCase().replace(/-/g, '_')
  const cats = TOOL_POLICY_CATEGORIES[key]
  if (!cats) return listTools()
  return listTools().filter((n) => cats.has(TOOL_REGISTRY.tools[n]?.category ?? ''))
}

export const toolRegistryRouter = Router()

// GET /api/tool-registry — full manifest.
toolRegistryRouter.get('/', (_req, res) => {
  res.json(TOOL_REGISTRY)
})

// GET /api/tool-registry/tools — names only.
toolRegistryRouter.get('/tools', (_req, res) => {
  res.json({ tools: listTools() })
})

// GET /api/tool-registry/tools/:name — single descriptor.
toolRegistryRouter.get('/tools/:name', (req, res) => {
  const desc = TOOL_REGISTRY.tools[String(req.params.name)]
  if (!desc) {
    res.status(404).json({ code: 'TOOL_NOT_FOUND', name: req.params.name })
    return
  }
  res.json(desc)
})

// GET /api/tool-registry/by-category/:category
toolRegistryRouter.get('/by-category/:category', (req, res) => {
  const cat = String(req.params.category)
  res.json({
    tools: listTools().filter((n) => TOOL_REGISTRY.tools[n]?.category === cat),
  })
})

// GET /api/tool-registry/effective?toolPolicy=READ_ONLY — what the
// runtime will actually expose under that tool_policy. Designer (M91.C)
// calls this to render the operator's effective-tool list.
toolRegistryRouter.get('/effective', (req, res) => {
  const tp = typeof req.query.toolPolicy === 'string' ? req.query.toolPolicy : undefined
  res.json({
    tool_policy: tp ?? null,
    tools: effectiveToolsForPolicy(tp),
  })
})
