/**
 * M13 — code-changes proxy.
 *
 *   GET /api/runs/:runId/code-changes?cf_call_id=…
 *
 * The SPA already knows the cfCallId per AGENT_TASK execution (it's stored
 * in the snapshot payload, written by AgentTaskExecutor at line 235ish).
 * This router doesn't try to re-derive it — the caller passes it in. We
 * verify the run exists + the user can view it, then proxy to context-fabric
 * `/internal/mcp/code-changes`. context-fabric resolves the persisted ids
 * + the MCP server URL, then hydrates from MCP.
 */
import { Router, type Request, type Response } from 'express'
import { prisma } from '../../lib/prisma'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { assertInstancePermission } from '../../lib/permissions/workflowTemplate'

export const codeChangesRouter: Router = Router()

codeChangesRouter.get('/:runId/code-changes', async (req: Request, res: Response) => {
  const runId = req.params.runId as string
  const explicit = typeof req.query.cf_call_id === 'string' ? req.query.cf_call_id : undefined
  const userId = (req as { user?: { userId: string } }).user?.userId as string | undefined

  // Permission check — `runId` is either a WorkflowInstance id (server-driven
  // run) or a RunSnapshot id (browser-driven). Try the instance check first;
  // fall back to the snapshot's underlying workflow template.
  try {
    if (userId) {
      await assertInstancePermission(userId, runId, 'view').catch(async () => {
        const snap = await prisma.runSnapshot.findUnique({ where: { runId }, select: { workflowId: true } })
        if (snap) {
          const { assertTemplatePermission } = await import('../../lib/permissions/workflowTemplate')
          await assertTemplatePermission(userId, snap.workflowId, 'view')
        }
      })
    }
  } catch (err) {
    return res.status(403).json({ error: (err as Error).message })
  }

  // Resolve cfCallIds + per-cfCallId lookup hints (codeChangeIds + mcpServerId).
  // Two sources, fanned in together so the run-insights page sees code changes
  // regardless of who recorded them:
  //   (a) AgentRunOutput.structuredPayload.cfCallId   (server-driven runs)
  //   (b) BlueprintSession.metadata.stageAttempts[].correlation.{cfCallId,
  //       codeChangeIds, mcpServerId} + blueprint_artifacts.payload
  //       (Workbench-driven runs that pause at the bridge node)
  //
  // Before this M41.1.2 fix, (b) was invisible to /api/runs/:runId/code-changes
  // so a workflow paused at the Workbench bridge would render
  // "This run did not touch any source files." even though the workbench
  // itself was showing diffs from the same execution.
  type Lookup = { cfCallId: string; codeChangeIds: Set<string>; mcpServerId?: string }
  const lookups = new Map<string, Lookup>()
  const addLookup = (source: Record<string, unknown> | null | undefined) => {
    if (!source) return
    const cfCallId = source.cfCallId
    if (typeof cfCallId !== 'string' || !cfCallId) return
    const current = lookups.get(cfCallId) ?? { cfCallId, codeChangeIds: new Set<string>() }
    const rawIds = source.codeChangeIds
    if (Array.isArray(rawIds)) {
      for (const rawId of rawIds) {
        if (typeof rawId === 'string' && rawId.trim()) current.codeChangeIds.add(rawId.trim())
      }
    }
    const mcpServerId = source.mcpServerId
    if (typeof mcpServerId === 'string' && mcpServerId.trim()) current.mcpServerId = mcpServerId.trim()
    lookups.set(cfCallId, current)
  }
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v)

  if (explicit) {
    addLookup({ cfCallId: explicit })
  } else {
    // (a) AgentRun outputs
    const runs = await prisma.agentRun.findMany({
      where: { instanceId: runId },
      select: { outputs: { select: { structuredPayload: true } } },
    })
    for (const r of runs) for (const o of r.outputs) {
      addLookup(isRecord(o.structuredPayload) ? o.structuredPayload : null)
    }

    // (b) Blueprint stage attempts + artifacts on any sessions linked to
    // this workflow run. Same shape buildLoopStageVars + the workbench
    // code-changes endpoint use, so a session paused at the Workbench
    // bridge still surfaces its diffs on the workflow run page.
    const sessions = await prisma.blueprintSession.findMany({
      where: { workflowInstanceId: runId },
      select: { id: true, metadata: true, artifacts: { select: { payload: true } } },
    })
    for (const s of sessions) {
      const meta = isRecord(s.metadata) ? s.metadata : {}
      const attempts = Array.isArray(meta.stageAttempts) ? meta.stageAttempts : []
      for (const attempt of attempts) {
        if (!isRecord(attempt)) continue
        addLookup(isRecord(attempt.correlation) ? attempt.correlation : null)
      }
      for (const artifact of s.artifacts) {
        addLookup(isRecord(artifact.payload) ? artifact.payload : null)
      }
    }
  }

  if (lookups.size === 0) {
    return res.json({ runId, cfCallIds: [], items: [], stale: false })
  }

  // Fan out — context-fabric returns one response per cfCallId; flatten.
  // Per-cfCallId codeChangeIds + mcpServerId narrow the lookup so the
  // bridge-relayed Workbench changes resolve under the right MCP server.
  const lookupList = [...lookups.values()]
  try {
    const settled = await Promise.allSettled(lookupList.map(lookup =>
      contextFabricClient.listCodeChanges(lookup.cfCallId, {
        codeChangeIds: lookup.codeChangeIds.size > 0 ? [...lookup.codeChangeIds] : undefined,
        mcpServerId: lookup.mcpServerId,
      }),
    ))
    const items = settled.flatMap(r => r.status === 'fulfilled' ? r.value.items : [])
    const stale = settled.some(r => r.status === 'fulfilled' && r.value.stale)
    const errors = settled.flatMap(r => r.status === 'rejected' ? [(r.reason as Error).message] : [])

    // M16 — mirror to Consumable so the existing artifact UI surfaces these
    // alongside contracts/deliverables. Best-effort: failures don't fail the
    // proxy response. Idempotent on (runId, code-change id) via name match.
    const consumableIds = await mirrorToConsumables(runId, items, userId)
    return res.json({ runId, cfCallIds: lookupList.map(l => l.cfCallId), items, stale, consumableIds, errors })
  } catch (err) {
    const e = err as { status?: number; message?: string }
    return res.status(e.status ?? 502).json({ error: e.message ?? 'context-fabric error' })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// M16 — Consumable mirror.
//
// Each code-change becomes a `Consumable` row of type `CODE_CHANGE`. The
// `name` field encodes (runId, code-change id) so re-fetching is idempotent.
// `formData` carries the structured payload so the SPA can render it inline.
// instanceId links back to the WorkflowInstance when available; for snapshot
// runs it stays null (Consumable.instanceId is optional).
// ────────────────────────────────────────────────────────────────────────────

const MIRROR_TYPE_NAME = 'CODE_CHANGE'

interface MirrorItem { id: string; tool_name?: string; paths_touched?: string[]; commit_sha?: string }

async function mirrorToConsumables(runId: string, items: MirrorItem[], userId?: string): Promise<string[]> {
  if (items.length === 0) return []
  try {
    const type = await prisma.consumableType.upsert({
      where:  { name: MIRROR_TYPE_NAME },
      update: {},
      create: {
        name: MIRROR_TYPE_NAME,
        description: 'Mirror of MCP code-change records (M13). Auto-created on first fetch.',
        requiresApproval: false,
        allowVersioning:  false,
      },
    })
    // Use WorkflowInstance.id when runId resolves to one; otherwise leave null.
    const inst = await prisma.workflowInstance.findUnique({ where: { id: runId }, select: { id: true } })
    const out: string[] = []
    for (const it of items) {
      if (!it.id) continue
      const naturalName = `${runId}::${it.id}` // dedup key
      // Look up an existing mirror for this (runId, code-change id).
      const existing = await prisma.consumable.findFirst({
        where: { typeId: type.id, name: naturalName },
        select: { id: true },
      })
      if (existing) { out.push(existing.id); continue }
      const created = await prisma.consumable.create({
        data: {
          typeId: type.id,
          instanceId: inst?.id ?? null,
          name: naturalName,
          status: 'PUBLISHED',
          formData: {
            codeChangeId: it.id,
            toolName:     it.tool_name ?? null,
            pathsTouched: it.paths_touched ?? [],
            commitSha:    it.commit_sha ?? null,
            mirroredAt:   new Date().toISOString(),
            runId,
          },
          createdById: userId,
        },
      })
      out.push(created.id)
    }
    return out
  } catch (err) {
    // Mirror failure shouldn't block the read. Surface to logs only.
    // eslint-disable-next-line no-console
    console.warn(`[code-changes] consumable mirror failed for run ${runId}: ${(err as Error).message}`)
    return []
  }
}
