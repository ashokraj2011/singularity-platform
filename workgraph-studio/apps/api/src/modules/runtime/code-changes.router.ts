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

  // Resolve cfCallIds. Caller can pass one explicitly; otherwise we derive
  // every cfCallId stored on AgentRunOutput.structuredPayload for this run's
  // AgentRuns. That payload is written by AgentTaskExecutor on completion.
  let cfCallIds: string[] = []
  if (explicit) {
    cfCallIds = [explicit]
  } else {
    const runs = await prisma.agentRun.findMany({
      where: { instanceId: runId },
      select: { outputs: { select: { structuredPayload: true } } },
    })
    const seen = new Set<string>()
    for (const r of runs) for (const o of r.outputs) {
      const id = (o.structuredPayload as { cfCallId?: string } | null)?.cfCallId
      if (id && !seen.has(id)) { seen.add(id); cfCallIds.push(id) }
    }
  }

  if (cfCallIds.length === 0) {
    return res.json({ runId, cfCallIds: [], items: [], stale: false })
  }

  // Fan out — context-fabric returns one response per cfCallId; flatten.
  try {
    const responses = await Promise.all(cfCallIds.map(id => contextFabricClient.listCodeChanges(id)))
    const items = responses.flatMap(r => r.items)
    const stale = responses.some(r => r.stale)
    return res.json({ runId, cfCallIds, items, stale })
  } catch (err) {
    const e = err as { status?: number; message?: string }
    return res.status(e.status ?? 502).json({ error: e.message ?? 'context-fabric error' })
  }
})
