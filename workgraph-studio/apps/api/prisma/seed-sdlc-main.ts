/**
 * Main-profile entry point for the proper 6-stage SDLC loop.
 *
 * A workbench-profile template (seed-sdlc-workbench.ts → "SDLC implementation
 * loop") is a sub-flow, not a top-level entry point: a profile='main' workflow
 * has to drive it via a CALL_WORKFLOW node (the same pattern the demo
 * "Epic → Story" uses). This seed creates that Main wrapper:
 *
 *     START → CALL_WORKFLOW("SDLC implementation loop") → END
 *
 * plus a WorkItemRoutingPolicy (feature → SDLC) at priority 200 so newly
 * created `feature` work items resolve to this wrapper. Routing precedence is
 * `priority desc` (work-item-routing.service.ts), so 200 wins over the demo's
 * existing feature→SDLC row (priority 100) WITHOUT modifying or deleting it —
 * flip this one's isActive=false to fall back to the demo route.
 *
 * The CALL_WORKFLOW target is resolved by NAME at seed time, so it stays
 * correct even though seed-sdlc-workbench.ts assigns the loop a fresh id on
 * every (delete+recreate) run.
 *
 * Idempotent — fixed ids, upserted. Run:
 *   SEED_CAPABILITY_ID=… SEED_TEAM_ID=… npx tsx prisma/seed-sdlc-main.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Default to the demo capability/team so the wrapper lands in the same scope as
// the visible demo workflows (override via env to target another tenant).
const CAPABILITY_ID = process.env.SEED_CAPABILITY_ID ?? '11111111-2222-3333-4444-555555555555'
const TEAM_ID = process.env.SEED_TEAM_ID ?? '50000000-0000-0000-0000-000000000001'
const SDLC_LOOP_NAME = process.env.SEED_SDLC_LOOP_NAME ?? 'SDLC implementation loop'

// Stable ids (the `…a0` block is unused by seed-demo-workflows).
const WF_ID = '30000000-0000-0000-0000-0000000000a0'
const PHASE_ID = '31000000-0000-0000-0000-0000000000a0'
const N_START = '32000000-0000-0000-0000-0000000000a0'
const N_CALL = '32000000-0000-0000-0000-0000000000a1'
const N_END = '32000000-0000-0000-0000-0000000000a2'
const E1 = '33000000-0000-0000-0000-0000000000a0'
const E2 = '33000000-0000-0000-0000-0000000000a1'
const ROUTE_ID = '34000000-0000-0000-0000-0000000000a0'

type Json = Record<string, unknown>

async function upsertWorkflowShell(w: {
  id: string; name: string; description: string; profile: string; workflowTypeKey: string
  graphSnapshot: Json; phaseId: string; phaseName: string
}) {
  await (prisma as any).workflow.upsert({
    where: { id: w.id },
    update: { name: w.name, description: w.description, profile: w.profile, workflowTypeKey: w.workflowTypeKey, capabilityId: CAPABILITY_ID, teamId: TEAM_ID },
    create: {
      id: w.id, name: w.name, description: w.description, status: 'PUBLISHED', currentVersion: 1,
      profile: w.profile, workflowTypeKey: w.workflowTypeKey, teamId: TEAM_ID, capabilityId: CAPABILITY_ID,
    },
  })
  await (prisma as any).workflowVersion.upsert({
    where: { templateId_version: { templateId: w.id, version: 1 } },
    update: { graphSnapshot: w.graphSnapshot },
    create: { templateId: w.id, version: 1, graphSnapshot: w.graphSnapshot },
  })
  await (prisma as any).workflowDesignPhase.upsert({
    where: { id: w.phaseId },
    update: { name: w.phaseName },
    create: { id: w.phaseId, workflowId: w.id, name: w.phaseName, displayOrder: 0 },
  })
}

async function upsertNode(n: { id: string; nodeType: string; label: string; config?: Json; positionX: number; positionY: number }) {
  const config = n.config ?? {}
  await (prisma as any).workflowDesignNode.upsert({
    where: { id: n.id },
    update: { label: n.label, nodeType: n.nodeType as any, config, phaseId: PHASE_ID },
    create: {
      id: n.id, workflowId: WF_ID, phaseId: PHASE_ID, nodeType: n.nodeType as any,
      label: n.label, config, executionLocation: 'SERVER' as any, positionX: n.positionX, positionY: n.positionY,
    },
  })
}

async function upsertEdge(e: { id: string; sourceNodeId: string; targetNodeId: string }) {
  await (prisma as any).workflowDesignEdge.upsert({
    where: { id: e.id },
    update: { edgeType: 'SEQUENTIAL' as any },
    create: { id: e.id, workflowId: WF_ID, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, edgeType: 'SEQUENTIAL' as any },
  })
}

async function main() {
  const loop = await (prisma as any).workflow.findFirst({
    where: { name: SDLC_LOOP_NAME, profile: 'workbench' },
    select: { id: true, name: true, capabilityId: true },
  })
  if (!loop) {
    throw new Error(`Sub-workflow "${SDLC_LOOP_NAME}" (profile=workbench) not found — run seed-sdlc-workbench.ts first.`)
  }
  console.log(`Linking Main wrapper → "${loop.name}" (${loop.id})`)

  await upsertWorkflowShell({
    id: WF_ID,
    name: 'SDLC Delivery',
    description: 'Main entry point: dispatches a work item into the 6-stage "SDLC implementation loop" as a sub-workflow.',
    profile: 'main',
    workflowTypeKey: 'SDLC',
    graphSnapshot: {
      nodes: [{ id: N_START, type: 'START' }, { id: N_CALL, type: 'CALL_WORKFLOW' }, { id: N_END, type: 'END' }],
      edges: [{ from: N_START, to: N_CALL }, { from: N_CALL, to: N_END }],
    },
    phaseId: PHASE_ID,
    phaseName: 'Main',
  })
  await upsertNode({ id: N_START, nodeType: 'START', label: 'Intake', positionX: 80, positionY: 160 })
  // CALL_WORKFLOW executor resolves the child via config.standard.templateId
  // (or config.templateId) — NOT workflowId. Set standard.templateId so the
  // node both spawns at runtime and renders correctly in NodeInspector.
  await upsertNode({ id: N_CALL, nodeType: 'CALL_WORKFLOW', label: 'Run SDLC loop', config: { standard: { templateId: loop.id }, templateId: loop.id, workflowId: loop.id }, positionX: 320, positionY: 160 })
  await upsertNode({ id: N_END, nodeType: 'END', label: 'Done', positionX: 600, positionY: 160 })
  await upsertEdge({ id: E1, sourceNodeId: N_START, targetNodeId: N_CALL })
  await upsertEdge({ id: E2, sourceNodeId: N_CALL, targetNodeId: N_END })
  console.log(`✓ Main workflow "SDLC Delivery" (${WF_ID})`)

  // feature → SDLC → this wrapper, priority 200 (wins over the demo's 100).
  await (prisma as any).workItemRoutingPolicy.upsert({
    where: { id: ROUTE_ID },
    update: { workflowId: WF_ID, priority: 200, isActive: true },
    create: {
      id: ROUTE_ID, capabilityId: CAPABILITY_ID, workItemTypeKey: 'feature', workflowTypeKey: 'SDLC',
      workflowId: WF_ID, routingMode: 'MANUAL', priority: 200, isActive: true,
    },
  })
  console.log(`✓ routing feature→SDLC → "SDLC Delivery" (priority 200, supersedes demo route)`)
}

main()
  .then(() => console.log('✓ done'))
  .catch((e) => { console.error('ERR', e?.message ?? e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
