/**
 * Copilot-executor SDLC flow (§13.4).
 *
 * Unlike "SDLC implementation loop" (a single WORKBENCH_TASK that runs the
 * blueprint stage machine with gates + consumables), this is a plain workflow of
 * AGENT_TASK nodes — ONE per phase — each marked `config.executor: 'copilot'`.
 * At runtime AgentTaskExecutor passes that flag into run_context, context-fabric
 * dispatches the `copilot_execute` tool to the user's laptop mcp-server, and the
 * GitHub Copilot CLI does the whole phase agentically in the work-item workspace.
 * No function-calling loop, no workbench gates — the workflow orchestrates,
 * Copilot executes each phase, output flows phase→phase via prior_outputs.
 *
 *   START → Requirements → Design → Develop → QA → Security → Release → GIT_PUSH → END
 *
 * Each AGENT_TASK ends at AWAITING_REVIEW (the standard agent-node governance);
 * approve a phase to advance to the next.
 *
 * Idempotent — fixed ids, upserted. Run (after the role agent templates exist):
 *   SEED_CAPABILITY_ID=… SEED_TEAM_ID=… npx tsx prisma/seed-sdlc-copilot.ts
 */
import { PrismaClient, type NodeType } from '@prisma/client'

const prisma = new PrismaClient()

const CAPABILITY_ID = process.env.SEED_CAPABILITY_ID ?? '11111111-2222-3333-4444-555555555555'
const TEAM_ID = process.env.SEED_TEAM_ID ?? '50000000-0000-0000-0000-000000000001'
// Reuse the same role agent templates the workbench SDLC seed uses, so this
// flow drops into the same environment (override via env per deployment).
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT ?? '885ae4d8-7e5a-4f8c-81c1-1672889ac776'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT ?? '19f65cc6-f2f2-4c42-a0ac-27d180da07e9'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT ?? 'aaa33b61-651c-4d1b-91ad-266febccdcb6'
const QA_AGENT = process.env.SEED_QA_AGENT ?? 'b2e283d0-4df0-49ff-8404-3d67b09779c5'
const SECURITY_AGENT = process.env.SEED_SEC_AGENT ?? '0dc3d00f-6c7d-4f50-8d4b-2dae422a7d6f'
const DEVOPS_AGENT = process.env.SEED_DEVOPS_AGENT ?? '056f0ad7-185b-455a-86be-2c6576c4c2d9'

const WF_NAME = 'SDLC (Copilot CLI)'
const WF_ID = '3b000000-0000-0000-0000-0000000000c0'
const PHASE_ID = '3b100000-0000-0000-0000-0000000000c0'
const ROUTE_ID = '3b400000-0000-0000-0000-0000000000c0'
const id = (n: number) => `3b200000-0000-0000-0000-0000000000${n.toString(16).padStart(2, '0')}`
const eid = (n: number) => `3b300000-0000-0000-0000-0000000000${n.toString(16).padStart(2, '0')}`

type Json = Record<string, unknown>

interface Phase { key: string; label: string; agent: string; task: string }
const PHASES: Phase[] = [
  {
    key: 'REQUIREMENTS', label: 'Requirements (Copilot)', agent: PRODUCT_OWNER_AGENT,
    task: 'Write a clear Requirements & Acceptance spec for this work item:\n\n{{instance.vars.story}}\n\n' +
      'List functional requirements, acceptance criteria, and edge cases. Save it as REQUIREMENTS.md at the repo root.',
  },
  {
    key: 'DESIGN', label: 'Design (Copilot)', agent: ARCHITECT_AGENT,
    task: 'Produce a Design Document (and an ADR if a significant decision is involved) for:\n\n{{instance.vars.story}}\n\n' +
      'Cover components, data flow, and risks. Save it as DESIGN.md at the repo root.',
  },
  {
    key: 'DEVELOP', label: 'Develop (Copilot)', agent: DEVELOPER_AGENT,
    task: 'Implement this change end-to-end in the repository:\n\n{{instance.vars.story}}\n\n' +
      'Make the actual code edits, ADD or EXTEND unit tests for the new behavior, and run the tests until they pass.',
  },
  {
    key: 'QA', label: 'QA (Copilot)', agent: QA_AGENT,
    task: 'Run the project test suite for the implemented change and write a concise Test Report ' +
      '(scope, results, coverage) as TEST_REPORT.md at the repo root.',
  },
  {
    key: 'SECURITY', label: 'Security Review (Copilot)', agent: SECURITY_AGENT,
    task: 'Review the implemented change for security risks (input validation, authz, secrets, dependencies) ' +
      'and write a Risk Assessment as RISK_ASSESSMENT.md at the repo root.',
  },
  {
    key: 'RELEASE', label: 'Release Readiness (Copilot)', agent: DEVOPS_AGENT,
    task: 'Write a Release & Rollback plan and a short Ops Runbook for this change as RELEASE.md at the repo root.',
  },
]

async function upsertNode(n: { id: string; nodeType: string; label: string; config?: Json; x: number }) {
  const config = n.config ?? {}
  await (prisma as any).workflowDesignNode.upsert({
    where: { id: n.id },
    update: { label: n.label, nodeType: n.nodeType as NodeType, config, phaseId: PHASE_ID },
    create: {
      id: n.id, workflowId: WF_ID, phaseId: PHASE_ID, nodeType: n.nodeType as NodeType,
      label: n.label, config, executionLocation: 'SERVER', positionX: n.x, positionY: 200,
    },
  })
}

async function upsertEdge(e: { id: string; from: string; to: string }) {
  await (prisma as any).workflowDesignEdge.upsert({
    where: { id: e.id },
    update: { edgeType: 'SEQUENTIAL' },
    create: { id: e.id, workflowId: WF_ID, sourceNodeId: e.from, targetNodeId: e.to, edgeType: 'SEQUENTIAL' },
  })
}

async function main(): Promise<void> {
  console.log(`Seeding "${WF_NAME}" (AGENT_TASK chain, executor=copilot)…`)

  // Build the node id sequence: START, 6 phases, GIT_PUSH, END.
  const N_START = id(0)
  const phaseNodeIds = PHASES.map((_, i) => id(i + 1))
  const N_PUSH = id(PHASES.length + 1)
  const N_END = id(PHASES.length + 2)
  const order = [N_START, ...phaseNodeIds, N_PUSH, N_END]

  await (prisma as any).workflow.upsert({
    where: { id: WF_ID },
    update: { name: WF_NAME, capabilityId: CAPABILITY_ID, teamId: TEAM_ID, profile: 'main', workflowTypeKey: 'SDLC' },
    create: {
      id: WF_ID, name: WF_NAME,
      description: 'SDLC delivered by the GitHub Copilot CLI: one AGENT_TASK (executor=copilot) per phase. ' +
        'context-fabric dispatches copilot_execute to the laptop mcp-server, which runs the Copilot CLI in the work-item workspace.',
      status: 'PUBLISHED', currentVersion: 1, profile: 'main', workflowTypeKey: 'SDLC',
      teamId: TEAM_ID, capabilityId: CAPABILITY_ID,
    },
  })
  await (prisma as any).workflowVersion.upsert({
    where: { templateId_version: { templateId: WF_ID, version: 1 } },
    update: { graphSnapshot: { nodes: order.map((nid) => ({ id: nid })), edges: [] } },
    create: { templateId: WF_ID, version: 1, graphSnapshot: { nodes: order.map((nid) => ({ id: nid })), edges: [] } },
  })
  await (prisma as any).workflowDesignPhase.upsert({
    where: { id: PHASE_ID },
    update: { name: 'SDLC' },
    create: { id: PHASE_ID, workflowId: WF_ID, name: 'SDLC', displayOrder: 0 },
  })

  await upsertNode({ id: N_START, nodeType: 'START', label: 'Intake', x: 80 })
  for (const [i, phase] of PHASES.entries()) {
    await upsertNode({
      id: phaseNodeIds[i]!, nodeType: 'AGENT_TASK', label: phase.label, x: 80 + (i + 1) * 220,
      // executor:'copilot' → AgentTaskExecutor → run_context.executor → CF dispatches copilot_execute.
      config: { agentTemplateId: phase.agent, capabilityId: CAPABILITY_ID, task: phase.task, executor: 'copilot' },
    })
  }
  await upsertNode({
    id: N_PUSH, nodeType: 'GIT_PUSH', label: 'Push to remote', x: 80 + (PHASES.length + 1) * 220,
    config: { requireApproval: false, remote: 'origin', standard: { requireApproval: 'false', remote: 'origin' } },
  })
  await upsertNode({ id: N_END, nodeType: 'END', label: 'Done', x: 80 + (PHASES.length + 2) * 220 })

  for (let i = 0; i < order.length - 1; i++) {
    await upsertEdge({ id: eid(i), from: order[i]!, to: order[i + 1]! })
  }

  console.log(`✓ "${WF_NAME}" (${WF_ID}) — START → ${PHASES.map(p => p.key).join(' → ')} → GIT_PUSH → END`)
  console.log(`  every phase node: nodeType=AGENT_TASK, config.executor='copilot'`)

  // feature → SDLC → this Copilot flow, priority 300. Routing precedence is
  // `priority desc` (work-item-routing.service.ts), so 300 wins over the
  // workbench "SDLC Delivery" route (priority 200) and the demo route (100)
  // WITHOUT touching either — a newly created `feature` work item now resolves
  // to the Copilot flow. Flip isActive=false here to fall back to the workbench
  // SDLC.
  await (prisma as any).workItemRoutingPolicy.upsert({
    where: { id: ROUTE_ID },
    update: { workflowId: WF_ID, priority: 300, isActive: true },
    create: {
      id: ROUTE_ID, capabilityId: CAPABILITY_ID, workItemTypeKey: 'feature', workflowTypeKey: 'SDLC',
      workflowId: WF_ID, routingMode: 'MANUAL', priority: 300, isActive: true,
    },
  })
  console.log(`✓ routing feature→SDLC → "${WF_NAME}" (priority 300, supersedes the workbench SDLC route)`)
  console.log('  set {{story}} + the work item\'s {{repoUrl}}; run with a connected laptop where `copilot` is on PATH.')
}

main()
  .then(() => console.log('✓ done'))
  .catch((e) => { console.error('ERR', e?.message ?? e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
