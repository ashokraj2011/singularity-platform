/**
 * Sample workflow seed — "Bug Fix" + "SDLC".
 *
 * Two reusable MAIN-profile workflow templates that demonstrate the
 * common node types in the designer. Each is created as real
 * workflowDesignNode / workflowDesignEdge rows (the same tables the
 * designer canvas + the /design-graph endpoint read), NOT a
 * graphSnapshot blob — so they render and run.
 *
 * Idempotent: upserts the Workflow rows by fixed UUID and rebuilds
 * their design graph from scratch on every run (delete-then-create),
 * so re-running never duplicates nodes.
 *
 * Run:
 *   cd workgraph-studio/apps/api
 *   npx ts-node prisma/seed-sample-workflows.ts
 *
 * Prereqs: a reachable Postgres (DATABASE_URL) with migrations applied.
 * Reuses the Platform Team seeded by prisma/seed.ts; falls back to the
 * first team in the DB if that fixed ID isn't present.
 */
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

// Fixed IDs so re-runs upsert in place (no duplicates).
const PLATFORM_TEAM_ID = '50000000-0000-0000-0000-000000000001'
const BUGFIX_WORKFLOW_ID = '30000000-0000-0000-0000-0000000000b1'
const SDLC_WORKFLOW_ID = '30000000-0000-0000-0000-0000000000d1'

type NodeSpec = {
  key: string                 // local handle for wiring edges
  nodeType: string
  label: string
  config?: Record<string, unknown>
  x: number
  y: number
}

type EdgeSpec = {
  from: string                // NodeSpec.key
  to: string                  // NodeSpec.key
  edgeType?: 'SEQUENTIAL' | 'CONDITIONAL'
  label?: string
  // Legacy single-condition shape the runtime EdgeEvaluator understands:
  // { field, op, value }. Only meaningful for CONDITIONAL edges.
  condition?: { field: string; op: string; value: unknown }
}

/**
 * Rebuild a workflow's design graph from a node/edge spec.
 * Deletes any existing design nodes+edges for the workflow first so the
 * seed is idempotent.
 */
async function rebuildGraph(workflowId: string, nodes: NodeSpec[], edges: EdgeSpec[]) {
  await prisma.$transaction(async tx => {
    // Edges reference nodes (FK), so clear edges first, then nodes.
    await tx.workflowDesignEdge.deleteMany({ where: { workflowId } })
    await tx.workflowDesignNode.deleteMany({ where: { workflowId } })

    const idByKey: Record<string, string> = {}
    for (const n of nodes) {
      const created = await tx.workflowDesignNode.create({
        data: {
          workflowId,
          nodeType: n.nodeType as any,
          label: n.label,
          config: (n.config ?? {}) as Prisma.InputJsonValue,
          executionLocation: 'SERVER' as any,
          positionX: n.x,
          positionY: n.y,
        },
      })
      idByKey[n.key] = created.id
    }

    for (const e of edges) {
      const sourceNodeId = idByKey[e.from]
      const targetNodeId = idByKey[e.to]
      if (!sourceNodeId || !targetNodeId) {
        throw new Error(`Edge references unknown node: ${e.from} → ${e.to}`)
      }
      await tx.workflowDesignEdge.create({
        data: {
          workflowId,
          sourceNodeId,
          targetNodeId,
          edgeType: (e.edgeType ?? 'SEQUENTIAL') as any,
          label: e.label,
          condition: e.condition ? (e.condition as Prisma.InputJsonValue) : undefined,
        },
      })
    }
  })
}

async function main() {
  console.log('Seeding sample workflows (Bug Fix + SDLC)…')

  // Resolve a team to own the templates. Prefer the seed's Platform Team;
  // fall back to whatever team exists so this works against any DB.
  const team =
    (await prisma.team.findUnique({ where: { id: PLATFORM_TEAM_ID } })) ??
    (await prisma.team.findFirst())
  if (!team) {
    throw new Error(
      'No team found. Run the base seed (npm run prisma:seed) first so a team exists to own these workflows.',
    )
  }

  // ─── 1. Bug Fix ─────────────────────────────────────────────────────────
  // START → Triage → Root-Cause → [decision] → Fix → Review → Tests → Deploy → Done
  //                                     └─(not reproducible)→ Closed (Won't Fix)
  await prisma.workflow.upsert({
    where: { id: BUGFIX_WORKFLOW_ID },
    update: {
      name: 'Bug Fix',
      description: 'Triage → root-cause → fix → review → regression test → deploy. A decision gate routes non-reproducible reports to a won\'t-fix close.',
      teamId: team.id,
      workflowTypeKey: 'SDLC',
      metadata: { workflowType: 'SDLC', criticality: 'HIGH', domain: 'Engineering' } as Prisma.InputJsonValue,
      profile: 'main',
    },
    create: {
      id: BUGFIX_WORKFLOW_ID,
      name: 'Bug Fix',
      description: 'Triage → root-cause → fix → review → regression test → deploy. A decision gate routes non-reproducible reports to a won\'t-fix close.',
      teamId: team.id,
      workflowTypeKey: 'SDLC',
      metadata: { workflowType: 'SDLC', criticality: 'HIGH', domain: 'Engineering' } as Prisma.InputJsonValue,
      profile: 'main',
    },
  })

  await rebuildGraph(
    BUGFIX_WORKFLOW_ID,
    [
      { key: 'start',   nodeType: 'START',         label: 'Start',                   x: 80,   y: 240 },
      { key: 'triage',  nodeType: 'HUMAN_TASK',    label: 'Triage & reproduce',      x: 320,  y: 240, config: { assignmentMode: 'TEAM_QUEUE' } },
      { key: 'rca',     nodeType: 'AGENT_TASK',    label: 'Root-cause analysis',     x: 560,  y: 240 },
      { key: 'gate',    nodeType: 'DECISION_GATE', label: 'Confirmed & reproducible?', x: 800, y: 240 },
      { key: 'fix',     nodeType: 'WORKBENCH_TASK', label: 'Implement fix',          x: 1040, y: 160 },
      { key: 'review',  nodeType: 'APPROVAL',      label: 'Code review',             x: 1280, y: 160 },
      { key: 'tests',   nodeType: 'AGENT_TASK',    label: 'Regression tests',        x: 1520, y: 160 },
      { key: 'deploy',  nodeType: 'GIT_PUSH',      label: 'Deploy fix',              x: 1760, y: 160, config: { remote: 'origin', requireApproval: true } },
      { key: 'done',    nodeType: 'END',           label: 'Resolved',                x: 2000, y: 160 },
      { key: 'closed',  nodeType: 'END',           label: 'Closed (won\'t fix)',     x: 1040, y: 360 },
    ],
    [
      { from: 'start',  to: 'triage' },
      { from: 'triage', to: 'rca' },
      { from: 'rca',    to: 'gate' },
      { from: 'gate',   to: 'fix',    edgeType: 'CONDITIONAL', label: 'Confirmed', condition: { field: 'bugConfirmed', op: 'eq', value: true } },
      { from: 'gate',   to: 'closed', edgeType: 'CONDITIONAL', label: 'Not reproducible', condition: { field: 'bugConfirmed', op: 'eq', value: false } },
      { from: 'fix',    to: 'review' },
      { from: 'review', to: 'tests' },
      { from: 'tests',  to: 'deploy' },
      { from: 'deploy', to: 'done' },
    ],
  )
  console.log(`  ✓ Bug Fix  (${BUGFIX_WORKFLOW_ID})`)

  // ─── 2. SDLC ──────────────────────────────────────────────────────────────
  // Full software-delivery lifecycle, linear with two human gates.
  await prisma.workflow.upsert({
    where: { id: SDLC_WORKFLOW_ID },
    update: {
      name: 'SDLC',
      description: 'Requirements → design → design approval → development → QA → security review → deploy → release notes.',
      teamId: team.id,
      workflowTypeKey: 'SDLC',
      metadata: { workflowType: 'SDLC', criticality: 'MEDIUM', domain: 'Engineering' } as Prisma.InputJsonValue,
      profile: 'main',
    },
    create: {
      id: SDLC_WORKFLOW_ID,
      name: 'SDLC',
      description: 'Requirements → design → design approval → development → QA → security review → deploy → release notes.',
      teamId: team.id,
      workflowTypeKey: 'SDLC',
      metadata: { workflowType: 'SDLC', criticality: 'MEDIUM', domain: 'Engineering' } as Prisma.InputJsonValue,
      profile: 'main',
    },
  })

  await rebuildGraph(
    SDLC_WORKFLOW_ID,
    [
      { key: 'start',     nodeType: 'START',          label: 'Start',                 x: 80,   y: 240 },
      { key: 'reqs',      nodeType: 'HUMAN_TASK',     label: 'Requirements intake',   x: 320,  y: 240, config: { assignmentMode: 'TEAM_QUEUE' } },
      { key: 'design',    nodeType: 'AGENT_TASK',     label: 'Solution design',       x: 560,  y: 240 },
      { key: 'designApp', nodeType: 'APPROVAL',       label: 'Design approval',       x: 800,  y: 240 },
      { key: 'develop',   nodeType: 'WORKBENCH_TASK', label: 'Development',           x: 1040, y: 240 },
      { key: 'qa',        nodeType: 'AGENT_TASK',     label: 'QA & verification',     x: 1280, y: 240 },
      { key: 'security',  nodeType: 'APPROVAL',       label: 'Security review',       x: 1520, y: 240 },
      { key: 'deploy',    nodeType: 'GIT_PUSH',       label: 'Deploy to production',  x: 1760, y: 240, config: { remote: 'origin', requireApproval: true } },
      { key: 'notes',     nodeType: 'AGENT_TASK',     label: 'Release notes',         x: 2000, y: 240 },
      { key: 'done',      nodeType: 'END',            label: 'Released',              x: 2240, y: 240 },
    ],
    [
      { from: 'start',     to: 'reqs' },
      { from: 'reqs',      to: 'design' },
      { from: 'design',    to: 'designApp' },
      { from: 'designApp', to: 'develop' },
      { from: 'develop',   to: 'qa' },
      { from: 'qa',        to: 'security' },
      { from: 'security',  to: 'deploy' },
      { from: 'deploy',    to: 'notes' },
      { from: 'notes',     to: 'done' },
    ],
  )
  console.log(`  ✓ SDLC     (${SDLC_WORKFLOW_ID})`)

  console.log('Sample workflows seeded. Open the Workflows list (Main tab) to see them.')
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
