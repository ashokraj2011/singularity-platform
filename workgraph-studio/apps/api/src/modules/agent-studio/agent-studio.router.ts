/**
 * M23 — /api/agent-studio/* facade.
 *
 * Thin governance layer on top of agent-runtime + prompt-composer. Provides:
 *   - Capability-scoped listing with grouping into "common" vs "capability"
 *   - Derivation from a common base template
 *   - Patch (lock-aware via upstream)
 *   - Prompt preview hook so the Studio can render the prompt-layer tree
 *
 * The legacy `/api/lookup/agent-templates` route stays — it remains the cheap
 * proxy any picker can use. /api/agent-studio is the richer surface for the
 * new authoring UX.
 */

import { Router, type Request, type Response } from 'express'
import {
  listAgentTemplates,
  getAgentTemplate,
  deriveAgentTemplate,
  patchAgentTemplate,
  listPromptProfiles,
  AgentAndToolsError,
  type AgentTemplate,
} from '../../lib/agent-and-tools/client'

export const agentStudioRouter: Router = Router()

// ── shared types ───────────────────────────────────────────────────────────

export interface StudioAgent {
  id: string
  name: string
  description?: string
  roleType?: string
  capabilityId: string | null
  baseTemplateId: string | null
  scope: 'common' | 'capability'
  editable: boolean
  lockedReason: string | null
  basePromptProfileId: string | null
  status?: string
  createdAt?: string
  updatedAt?: string
}

function shapeAgent(raw: AgentTemplate): StudioAgent {
  const r = raw as Record<string, unknown>
  const capabilityId = (r.capabilityId as string | undefined) ?? null
  const lockedReason = (r.lockedReason as string | undefined) ?? null
  return {
    id:                  raw.id,
    name:                raw.name,
    description:         (r.description as string | undefined) ?? undefined,
    roleType:            (r.roleType as string | undefined),
    capabilityId,
    baseTemplateId:      (r.baseTemplateId as string | undefined) ?? null,
    scope:               capabilityId ? 'capability' : 'common',
    editable:            capabilityId != null && lockedReason == null,
    lockedReason,
    basePromptProfileId: (r.basePromptProfileId as string | undefined) ?? null,
    status:              (r.status as string | undefined),
    createdAt:           (r.createdAt as string | undefined),
    updatedAt:           (r.updatedAt as string | undefined),
  }
}

function authHeader(req: Request): string | undefined {
  return typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
}

function param(req: Request, key: string): string {
  const v = req.params[key]
  return Array.isArray(v) ? v[0] : v
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /api/agent-studio/capabilities/:capabilityId/agents
// Returns common library ∪ capability-derived agents, grouped + normalized.
agentStudioRouter.get('/capabilities/:capabilityId/agents', async (req: Request, res: Response, next) => {
  try {
    const capabilityId = param(req, 'capabilityId')
    const raw = await listAgentTemplates(authHeader(req), { capabilityId, limit: 100 })
    const items = raw.map(shapeAgent)
    const common     = items.filter((a) => a.scope === 'common')
    const capability = items.filter((a) => a.scope === 'capability' && a.capabilityId === capabilityId)
    res.json({ capabilityId, common, capability })
  } catch (err) {
    next(err)
  }
})

// POST /api/agent-studio/capabilities/:capabilityId/agents/:baseId/derive
agentStudioRouter.post(
  '/capabilities/:capabilityId/agents/:baseId/derive',
  async (req: Request, res: Response, next) => {
    try {
      const capabilityId = param(req, 'capabilityId')
      const baseId       = param(req, 'baseId')
      const body = (req.body ?? {}) as Record<string, unknown>
      const derived = await deriveAgentTemplate(
        baseId,
        {
          capabilityId,
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          basePromptProfileId: typeof body.basePromptProfileId === 'string' ? body.basePromptProfileId : undefined,
        },
        authHeader(req),
      )
      res.status(201).json(shapeAgent(derived))
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /api/agent-studio/agents/:id
// Upstream enforces the lock. Forward the error verbatim on 403.
agentStudioRouter.patch('/agents/:id', async (req: Request, res: Response, next) => {
  try {
    const updated = await patchAgentTemplate(param(req, 'id'), (req.body ?? {}) as Record<string, unknown>, authHeader(req))
    res.json(shapeAgent(updated))
  } catch (err) {
    if (err instanceof AgentAndToolsError && err.status === 403) {
      res.status(403).json({ code: 'TEMPLATE_LOCKED', detail: err.detail ?? null })
      return
    }
    next(err)
  }
})

// GET /api/agent-studio/agents/:id
agentStudioRouter.get('/agents/:id', async (req: Request, res: Response, next) => {
  try {
    const raw = await getAgentTemplate(param(req, 'id'), authHeader(req))
    if (!raw) {
      res.status(404).json({ code: 'NOT_FOUND' })
      return
    }
    res.json(shapeAgent(raw))
  } catch (err) {
    next(err)
  }
})

// GET /api/agent-studio/capabilities/:capabilityId/prompt-profiles
// Returns capability-scoped profiles ∪ globally-scoped profiles so the Studio
// can render the prompt-layer tree side-by-side.
agentStudioRouter.get('/capabilities/:capabilityId/prompt-profiles', async (req: Request, res: Response, next) => {
  try {
    const profiles = await listPromptProfiles(authHeader(req))
    res.json({ items: profiles, total: profiles.length })
  } catch (err) {
    next(err)
  }
})

// GET /api/agent-studio/agents/:id/prompt-preview
// v0 — returns the resolved agent + its base prompt profile id so the SPA can
// fetch profile layers from /api/composer/* directly. A future iteration will
// call prompt-composer's previewOnly endpoint for the full layer tree.
agentStudioRouter.get('/agents/:id/prompt-preview', async (req: Request, res: Response, next) => {
  try {
    const raw = await getAgentTemplate(param(req, 'id'), authHeader(req))
    if (!raw) {
      res.status(404).json({ code: 'NOT_FOUND' })
      return
    }
    const shaped = shapeAgent(raw)
    res.json({
      agent: shaped,
      promptProfileId: shaped.basePromptProfileId,
      warnings: shaped.basePromptProfileId ? [] : ['agent has no basePromptProfileId — runs will rely on capability/role defaults'],
    })
  } catch (err) {
    next(err)
  }
})
