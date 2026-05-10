/**
 * M11.d — unified receipt endpoint.
 *
 * Returns a chronological merged timeline for a given `trace_id`:
 *   1. workgraph-side receipts (AgentRun, ToolRun, ApprovalRequest, AgentReview)
 *      - traceId is stored on AgentRunOutput.structuredPayload (M9.z),
 *        so we join AgentRun via that JSON path.
 *   2. context-fabric-side receipts (CallLog + events_store) — fetched live
 *      from cf `/receipts?trace_id=` and concatenated.
 *
 * Envelope shape is canonical (kept identical to cf/receipts.py):
 *   { receipt_id, kind, source_service, trace_id, subject{kind,id},
 *     actor{kind,id}, status, started_at, completed_at, correlation,
 *     metrics, payload }
 */

import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { config } from '../../config'

export const receiptsRouter: Router = Router()

interface ReceiptEnvelope {
  receipt_id:     string
  kind:           string
  source_service: string
  trace_id:       string | null
  subject:        { kind: string; id: string }
  actor:          { kind: string; id: string | null } | null
  status:         string
  started_at:     string | null
  completed_at:   string | null
  correlation:    Record<string, unknown>
  metrics:        Record<string, unknown>
  payload:        Record<string, unknown>
}

function asIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

// ── workgraph local receipts ───────────────────────────────────────────────

async function localReceipts(traceId: string): Promise<ReceiptEnvelope[]> {
  const out: ReceiptEnvelope[] = []

  // M9.z stores traceId on AgentRunOutput.structuredPayload. Use a raw query
  // for the JSON path since Prisma can't filter into nested JSON ergonomically.
  const agentRuns = await prisma.$queryRaw<Array<{
    id: string; agent_id: string; instance_id: string | null; node_id: string | null;
    status: string; started_at: Date | null; completed_at: Date | null;
  }>>(Prisma.sql`
    SELECT DISTINCT ar.id, ar."agentId" AS agent_id, ar."instanceId" AS instance_id,
           ar."nodeId" AS node_id, ar.status::text AS status,
           ar."startedAt" AS started_at, ar."completedAt" AS completed_at
    FROM agent_runs ar
    JOIN agent_run_outputs aro ON aro."runId" = ar.id
    WHERE aro."structuredPayload"->>'traceId' = ${traceId}
  `)

  for (const r of agentRuns) {
    out.push({
      receipt_id:     r.id,
      kind:           'agent_run',
      source_service: 'workgraph-api',
      trace_id:       traceId,
      subject:        { kind: 'agent_run', id: r.id },
      actor:          r.agent_id ? { kind: 'agent', id: r.agent_id } : null,
      status:         r.status.toLowerCase(),
      started_at:     asIso(r.started_at),
      completed_at:   asIso(r.completed_at),
      correlation: {
        traceId,
        agentRunId:        r.id,
        workflowInstanceId: r.instance_id,
        workflowNodeId:    r.node_id,
      },
      metrics: {},
      payload: {},
    })
  }

  // Approval reviews on those agent runs (status decision events).
  const runIds = agentRuns.map((r) => r.id)
  if (runIds.length) {
    const reviews = await prisma.agentReview.findMany({
      where: { runId: { in: runIds } },
      orderBy: { reviewedAt: 'asc' },
    })
    for (const rv of reviews) {
      out.push({
        receipt_id:     rv.id,
        kind:           'approval',
        source_service: 'workgraph-api',
        trace_id:       traceId,
        subject:        { kind: 'agent_run', id: rv.runId },
        actor:          { kind: 'user', id: rv.reviewedById },
        status:         rv.decision.toLowerCase(),
        started_at:     asIso(rv.reviewedAt),
        completed_at:   asIso(rv.reviewedAt),
        correlation:    { traceId, agentRunId: rv.runId },
        metrics:        {},
        payload:        { notes: rv.notes ?? null, reviewer_id: rv.reviewedById },
      })
    }
  }

  // ApprovalRequest table is workflow-level (not bound to a single agent run);
  // join via WorkflowInstance ↔ AgentRun.instanceId when known.
  const instanceIds = Array.from(new Set(agentRuns.map((r) => r.instance_id).filter(Boolean))) as string[]
  if (instanceIds.length) {
    const approvals = await prisma.approvalRequest.findMany({
      where: { instanceId: { in: instanceIds } },
      include: { decisions: true },
    })
    for (const ap of approvals) {
      out.push({
        receipt_id:     ap.id,
        kind:           'approval',
        source_service: 'workgraph-api',
        trace_id:       traceId,
        subject:        { kind: 'approval_request', id: ap.id },
        actor:          null,
        status:         ap.status.toLowerCase(),
        started_at:     asIso(ap.createdAt),
        completed_at:   asIso(ap.updatedAt),
        correlation:    { traceId, workflowInstanceId: ap.instanceId, nodeId: ap.nodeId },
        metrics:        {},
        payload:        { decisions: ap.decisions.map((d) => ({ id: d.id, decision: d.decision, decided_by: d.decidedById })) },
      })
    }
  }

  // ToolRun(s) on this trace — best-effort: join via instanceId. ToolRun has
  // no direct trace_id today; tighten in M11.e when events carry it.
  if (instanceIds.length) {
    const toolRuns = await prisma.toolRun.findMany({
      where: { instanceId: { in: instanceIds } },
    })
    for (const tr of toolRuns) {
      out.push({
        receipt_id:     tr.id,
        kind:           'tool_invocation',
        source_service: 'workgraph-api',
        trace_id:       traceId,
        subject:        { kind: 'tool_run', id: tr.id },
        actor:          tr.toolId ? { kind: 'tool', id: tr.toolId } : null,
        status:         tr.status.toLowerCase(),
        started_at:     asIso(tr.startedAt ?? tr.createdAt),
        completed_at:   asIso(tr.completedAt),
        correlation:    { traceId, toolRunId: tr.id, workflowInstanceId: tr.instanceId },
        metrics:        {},
        payload:        { idempotency_key: tr.idempotencyKey },
      })
    }
  }

  return out
}

// ── cf-side receipts (live fetch) ──────────────────────────────────────────

async function cfReceipts(traceId: string): Promise<ReceiptEnvelope[]> {
  const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/receipts?trace_id=${encodeURIComponent(traceId)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return []
    const body = await res.json() as { receipts?: ReceiptEnvelope[] }
    return body.receipts ?? []
  } catch {
    return []
  }
}

// ── GET /api/receipts?trace_id= ────────────────────────────────────────────

receiptsRouter.get('/', async (req, res) => {
  const traceId = req.query.trace_id as string | undefined
  if (!traceId) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'trace_id is required' })
  }
  const includeCf = req.query.include_cf !== '0'

  const [local, cf] = await Promise.all([
    localReceipts(traceId).catch(() => []),
    includeCf ? cfReceipts(traceId) : Promise.resolve([]),
  ])

  const merged = [...local, ...cf].sort((a, b) => {
    const av = a.started_at ?? a.completed_at ?? ''
    const bv = b.started_at ?? b.completed_at ?? ''
    return av.localeCompare(bv)
  })

  res.json({
    trace_id: traceId,
    total:    merged.length,
    sources:  {
      'workgraph-api': local.length,
      'context-api':   cf.filter((r) => r.source_service === 'context-api').length,
      'mcp-server':    cf.filter((r) => r.source_service === 'mcp-server').length,
    },
    receipts: merged,
  })
})
