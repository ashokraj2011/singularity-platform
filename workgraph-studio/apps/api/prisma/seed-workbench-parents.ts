/**
 * Ensure every workbench-profile workflow has a Main parent.
 *
 * A profile='workbench' template is a sub-flow — it can only run when a
 * profile='main' workflow drives it through a CALL_WORKFLOW node. This script
 * scans all workbench workflows and, for any that no Main workflow already
 * calls, seeds a minimal wrapper:
 *
 *     START → CALL_WORKFLOW(<workbench>) → END
 *
 * in the SAME capability/team as the workbench, so scope is preserved.
 *
 * Idempotent:
 *   - "already has a Main parent" is detected by scanning CALL_WORKFLOW design
 *     nodes (config.workflowId == workbench id) whose owning workflow is main,
 *     so curated wrappers (e.g. "SDLC Delivery", "Epic → Story") are respected
 *     and never duplicated.
 *   - The generated wrapper is keyed by name ("Run: <workbench name>"); re-runs
 *     reuse it and rebuild its graph rather than creating a second copy.
 *
 * Run:  npx tsx prisma/seed-workbench-parents.ts
 */
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()
type Json = Record<string, unknown>

async function hasMainParent(workbenchId: string): Promise<string[]> {
  const callers = await (prisma as any).workflowDesignNode.findMany({
    where: { nodeType: 'CALL_WORKFLOW', config: { path: ['workflowId'], equals: workbenchId } },
    select: { workflowId: true },
  })
  const parentIds = [...new Set(callers.map((c: any) => c.workflowId))]
  if (parentIds.length === 0) return []
  const mains = await prisma.workflow.findMany({ where: { id: { in: parentIds }, profile: 'main' }, select: { name: true } })
  return mains.map((m) => m.name)
}

async function seedParent(wb: { id: string; name: string; capabilityId: string | null; teamId: string; workflowTypeKey: string }) {
  const wrapperName = `Run: ${wb.name}`
  const existing = await prisma.workflow.findFirst({ where: { name: wrapperName, profile: 'main' }, select: { id: true } })
  const wfId = existing?.id ?? randomUUID()

  // Rebuild the wrapper graph cleanly (edges → nodes → phases) for idempotency.
  await (prisma as any).workflowDesignEdge.deleteMany({ where: { workflowId: wfId } })
  await (prisma as any).workflowDesignNode.deleteMany({ where: { workflowId: wfId } })
  await (prisma as any).workflowDesignPhase.deleteMany({ where: { workflowId: wfId } })

  await prisma.workflow.upsert({
    where: { id: wfId },
    update: { name: wrapperName, profile: 'main', workflowTypeKey: wb.workflowTypeKey, capabilityId: wb.capabilityId ?? undefined, teamId: wb.teamId },
    create: {
      id: wfId, name: wrapperName,
      description: `Auto-seeded Main entry point that dispatches a work item into the "${wb.name}" workbench loop as a sub-workflow.`,
      status: 'PUBLISHED', currentVersion: 1, profile: 'main', workflowTypeKey: wb.workflowTypeKey,
      capabilityId: wb.capabilityId ?? null, teamId: wb.teamId,
    },
  })

  const phaseId = randomUUID(), nStart = randomUUID(), nCall = randomUUID(), nEnd = randomUUID()
  const e1 = randomUUID(), e2 = randomUUID()

  await (prisma as any).workflowVersion.upsert({
    where: { templateId_version: { templateId: wfId, version: 1 } },
    update: { graphSnapshot: graph(nStart, nCall, nEnd) as Json },
    create: { templateId: wfId, version: 1, graphSnapshot: graph(nStart, nCall, nEnd) as Json },
  })
  await (prisma as any).workflowDesignPhase.create({ data: { id: phaseId, workflowId: wfId, name: 'Main', displayOrder: 0 } })
  await node(wfId, phaseId, nStart, 'START', 'Intake', {}, 80)
  // CALL_WORKFLOW resolves the child via config.standard.templateId (see
  // CallWorkflowExecutor), not workflowId.
  await node(wfId, phaseId, nCall, 'CALL_WORKFLOW', `Run ${wb.name}`, { standard: { templateId: wb.id }, templateId: wb.id, workflowId: wb.id }, 320)
  await node(wfId, phaseId, nEnd, 'END', 'Done', {}, 600)
  await edge(wfId, e1, nStart, nCall)
  await edge(wfId, e2, nCall, nEnd)
  return wfId
}

function graph(nStart: string, nCall: string, nEnd: string) {
  return {
    nodes: [{ id: nStart, type: 'START' }, { id: nCall, type: 'CALL_WORKFLOW' }, { id: nEnd, type: 'END' }],
    edges: [{ from: nStart, to: nCall }, { from: nCall, to: nEnd }],
  }
}
async function node(workflowId: string, phaseId: string, id: string, nodeType: string, label: string, config: Json, x: number) {
  await (prisma as any).workflowDesignNode.create({
    data: { id, workflowId, phaseId, nodeType: nodeType as any, label, config, executionLocation: 'SERVER' as any, positionX: x, positionY: 160 },
  })
}
async function edge(workflowId: string, id: string, sourceNodeId: string, targetNodeId: string) {
  await (prisma as any).workflowDesignEdge.create({ data: { id, workflowId, sourceNodeId, targetNodeId, edgeType: 'SEQUENTIAL' as any } })
}

async function main() {
  const wbs = await prisma.workflow.findMany({
    where: { profile: 'workbench', archivedAt: null },
    select: { id: true, name: true, capabilityId: true, teamId: true, workflowTypeKey: true },
    orderBy: { name: 'asc' },
  })
  console.log(`Scanning ${wbs.length} workbench workflow(s)…`)
  let created = 0
  for (const wb of wbs) {
    const parents = await hasMainParent(wb.id)
    if (parents.length) { console.log(`  ✓ "${wb.name}" already driven by: ${parents.join(', ')}`); continue }
    const wfId = await seedParent(wb)
    created++
    console.log(`  + seeded Main parent "Run: ${wb.name}" (${wfId})`)
  }
  console.log(`Done. ${created} parent(s) created, ${wbs.length - created} already had one.`)
}

main()
  .catch((e) => { console.error('ERR', e?.message ?? e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
