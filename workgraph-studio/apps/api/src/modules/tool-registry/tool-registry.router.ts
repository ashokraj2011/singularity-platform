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

// M93.G/H — context_policy → category set. Mirrors the CF-side
// _CONTEXT_POLICY_CATEGORIES (stage_execution_policy.py) so the
// designer's preview reflects the same narrowing CF applies at runtime.
const CONTEXT_POLICY_CATEGORIES: Record<string, Set<string>> = {
  STORY_ONLY: new Set(['verify_meta', 'analyzer']),
  REPO_READ_ONLY: new Set(['read', 'verify_meta', 'analyzer']),
  CODE_EDIT: new Set(['read', 'mutate', 'run', 'finalize', 'verify_meta', 'analyzer']),
  VERIFY_ONLY: new Set(['read', 'run', 'verify_meta', 'analyzer']),
  EVIDENCE_REVIEW: new Set(['read', 'verify_meta', 'analyzer']),
  NONE: new Set<string>(),
}

function listTools(): string[] {
  return Object.keys(TOOL_REGISTRY.tools).sort()
}

interface EffectiveToolsFilter {
  toolPolicy?: string
  contextPolicy?: string
  repoAccess?: boolean
}

// M93.H — Full StageExecutionPolicy preview. Composes the same three
// filter dimensions CF's _filter_phase_tools applies in the SAME ORDER:
//   1. repo_access=false → strip every repo-touching category.
//   2. context_policy   → intersect with the policy's category set.
//   3. tool_policy      → intersect again.
// Each step only narrows. Pre-M93.H the preview only filtered by
// tool_policy, so it could claim 14 tools when runtime exposed 4
// (e.g. tool_policy=MUTATION + repoAccess=false → MUTATION's category
// set is broad, but repo_access=false strips everything except
// verify_meta/analyzer at runtime).
//
// Caveat acknowledged: this preview still doesn't intersect with the
// DB-seeded StagePolicy.phases[*].allowed_tools — that's an explicit
// per-stage/per-phase allowlist living in prompt-composer that further
// narrows the runtime set. Doing that here would require an extra
// HTTP hop into prompt-composer on every preview render; for now we
// document the limit. The preview's purpose is to show the operator
// "what your designer policy fields will produce" — not to be a
// drop-in for runtime ground truth.
function effectiveToolsForFilter(filter: EffectiveToolsFilter): string[] {
  let tools = listTools()

  // Belt #1: repo_access=false strips repo-touching categories.
  if (filter.repoAccess === false) {
    tools = tools.filter((n) => {
      const cat = TOOL_REGISTRY.tools[n]?.category ?? ''
      return cat === 'verify_meta' || cat === 'analyzer'
    })
  }

  // M93.G — context_policy filter.
  if (filter.contextPolicy) {
    const key = filter.contextPolicy.toUpperCase().replace(/-/g, '_')
    const cats = CONTEXT_POLICY_CATEGORIES[key]
    if (cats) {
      tools = tools.filter((n) => cats.has(TOOL_REGISTRY.tools[n]?.category ?? ''))
    }
  }

  // tool_policy filter (the original M91.C behaviour).
  if (filter.toolPolicy) {
    const key = filter.toolPolicy.toUpperCase().replace(/-/g, '_')
    const cats = TOOL_POLICY_CATEGORIES[key]
    if (cats) {
      tools = tools.filter((n) => cats.has(TOOL_REGISTRY.tools[n]?.category ?? ''))
    }
  }

  return tools
}

// Back-compat shim: prior callers passing only toolPolicy still work.
function effectiveToolsForPolicy(toolPolicy: string | undefined): string[] {
  return effectiveToolsForFilter({ toolPolicy })
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

// GET /api/tool-registry/effective
//   ?toolPolicy=READ_ONLY            (existing — narrows by tool_policy)
//   &contextPolicy=STORY_ONLY        (M93.H — narrows by context_policy)
//   &repoAccess=false                (M93.H — strips repo-touching tools)
//
// All three are optional; missing params mean "no filter on that
// dimension". The same three dimensions the workflow designer pins on
// a stage, applied in the same order CF's stage_execution_policy.py
// applies them at runtime, so the preview can't drift from reality.
//
// repoAccess is parsed leniently: "false" / "FALSE" / "0" → false;
// "true" / "1" → true; anything else → undefined (no filter). This
// matches the loose values the designer URL-encodes.
toolRegistryRouter.get('/effective', (req, res) => {
  const tp = typeof req.query.toolPolicy === 'string' ? req.query.toolPolicy : undefined
  const cp = typeof req.query.contextPolicy === 'string' ? req.query.contextPolicy : undefined
  const ra = typeof req.query.repoAccess === 'string'
    ? (['false', 'no', '0'].includes(req.query.repoAccess.trim().toLowerCase())
        ? false
        : (['true', 'yes', '1'].includes(req.query.repoAccess.trim().toLowerCase())
            ? true
            : undefined))
    : undefined
  res.json({
    tool_policy: tp ?? null,
    context_policy: cp ?? null,
    repo_access: ra ?? null,
    tools: effectiveToolsForFilter({ toolPolicy: tp, contextPolicy: cp, repoAccess: ra }),
  })
})
