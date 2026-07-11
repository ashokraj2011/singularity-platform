/**
 * Copilot-executor SDLC flow — EXTERNAL / off-platform variant.
 *
 * Sibling of seed-sdlc-copilot.ts. That flow runs each phase's Copilot CLI
 * SERVER-side (context-fabric dispatches copilot_execute to the paired laptop).
 * THIS variant is for running the whole SDLC OFF the platform: the operator
 * exports the run as a portable Copilot playbook (GET
 * /workflow-instances/:id/export/copilot-yaml), runs every phase on their own
 * Copilot CLI, and the run advances by SIGNALLING back.
 *
 * Topology:
 *   START → CREATE_BRANCH
 *         → [ per phase:  SIGNAL_WAIT(await external phase) → APPROVAL(review) ]
 *         → VERIFIER → GIT_PUSH → RAISE_PR → END
 *
 * Each phase is a SIGNAL_WAIT barrier that PARKS until the exported runner POSTs
 * `POST /workflow-instances/:id/signals/copilot.<KEY>` (see the runner's
 * post_signal + the export's platform.signalEndpoint). The barrier carries the
 * SAME copilot stage config the export reads (executor:'copilot' + task +
 * governedStageKey/Role + in/outputArtifacts), so the exported playbook still
 * shows each phase's prompt + document contract — it just doesn't EXECUTE the
 * agent server-side (nodeType SIGNAL_WAIT → SignalWaitExecutor, not
 * AgentTaskExecutor; config.executor is read only by the export's stage filter).
 *
 * "Respect approval gates": each phase's SIGNAL_WAIT is followed by an APPROVAL
 * node, so the phase's documents stay AWAITING_REVIEW for a human before the
 * NEXT phase's barrier opens. The runner is non-interactive (`--allow-all`) so it
 * fires every phase signal eagerly as it finishes; persistSignal /
 * consumePendingSignal durably match each UNIQUE `copilot.<KEY>` to its barrier
 * when that barrier activates (after the human approves the prior phase), so
 * eager signalling never races ahead of the approvals. Flip a phase's
 * `requiresApproval:false` to drop its review gate.
 *
 * NOT auto-routed — unlike seed-sdlc-copilot.ts this seeds NO workItemRoutingPolicy,
 * so it never supersedes the in-platform SDLC route. It is a PUBLISHED, COMMON
 * template an operator picks explicitly in guided launch.
 *
 * Idempotent — fixed ids, upserted. Run (after the role agent templates exist):
 *   SEED_CAPABILITY_ID=… SEED_TEAM_ID=… npx tsx prisma/seed-sdlc-copilot-external.ts
 */
import { PrismaClient, type NodeType } from '@prisma/client'

const prisma = new PrismaClient()

const TEAM_ID = process.env.SEED_TEAM_ID ?? '50000000-0000-0000-0000-000000000001'
// Role agent templates — same REAL AgentTemplate ids agent-runtime/prisma/seed.ts
// creates (00000000-…d1..d8), so the export's per-stage prompt names the role.
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT ?? '00000000-0000-0000-0000-0000000000d7'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT ?? '00000000-0000-0000-0000-0000000000d1'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT ?? '00000000-0000-0000-0000-0000000000d2'
const QA_AGENT = process.env.SEED_QA_AGENT ?? '00000000-0000-0000-0000-0000000000d3'
const SECURITY_AGENT = process.env.SEED_SEC_AGENT ?? '00000000-0000-0000-0000-0000000000d5'
const DEVOPS_AGENT = process.env.SEED_DEVOPS_AGENT ?? '00000000-0000-0000-0000-0000000000d6'
// Optional repo fallback (capability-INDEPENDENT: each phase resolves the WORK
// ITEM's capability + repo at runtime; sourceUri is only a last-resort fallback).
const DEFAULT_REPO = process.env.SEED_COPILOT_REPO_URL

const WF_NAME = 'SDLC (Copilot CLI — External)'
const WF_ID = '3be00000-0000-0000-0000-0000000000e0'
const PHASE_ID = '3be10000-0000-0000-0000-0000000000e0'
// Distinct id families from seed-sdlc-copilot.ts (3b2000…) so the two coexist.
const hx = (n: number) => n.toString(16).padStart(2, '0')
const nid = (n: number) => `3be20000-0000-0000-0000-0000000000${hx(n)}` // structural nodes
const sid = (n: number) => `3be24000-0000-0000-0000-0000000000${hx(n)}` // per-phase SIGNAL_WAIT
const aid = (n: number) => `3be28000-0000-0000-0000-0000000000${hx(n)}` // per-phase APPROVAL
const eid = (n: number) => `3be30000-0000-0000-0000-0000000000${hx(n)}` // edges

type Json = Record<string, unknown>

// ── Artifact IN/OUT contract (identical to seed-sdlc-copilot.ts) ────────────
interface ArtifactSpec { type: string; name: string }
const A = {
  requirements:   { type: 'requirements',    name: 'Requirements & Acceptance' },
  design:         { type: 'design',           name: 'Design Document' },
  implementation: { type: 'implementation',   name: 'Implementation' },
  testReport:     { type: 'test-report',      name: 'Test Report' },
  risk:           { type: 'risk-assessment',  name: 'Risk Assessment' },
  release:        { type: 'release-plan',     name: 'Release & Rollback Plan' },
} as const

const A_META: Record<string, { folder: string; file: string; template: string }> = {
  'requirements':    { folder: 'product-owner', file: 'REQUIREMENTS.md',    template: '# Requirements & Acceptance\n\n## Summary\n\n## Functional requirements\n- \n\n## Acceptance criteria\n- \n\n## Edge cases\n- \n\n## Out of scope\n- ' },
  'design':          { folder: 'architect',     file: 'DESIGN.md',          template: '# Design Document\n\n## Overview\n\n## Components\n\n## Data flow\n\n## Interfaces & contracts\n\n## Risks & trade-offs\n\n## Alternatives considered' },
  'implementation':  { folder: 'developer',     file: 'IMPLEMENTATION.md',  template: '# Implementation Summary\n\n## What changed\n\n## Why\n\n## Files touched\n- \n\n## Tests added\n- \n\n## How to verify' },
  'test-report':     { folder: 'qa',            file: 'TEST_REPORT.md',     template: '# Test Report\n\n## Scope\n\n## Results\n\n## Coverage\n\n## Defects & follow-ups\n- ' },
  'risk-assessment': { folder: 'security',      file: 'RISK_ASSESSMENT.md', template: '# Risk Assessment\n\n## Summary\n\n## Findings\n| Severity | Issue | Recommendation |\n| --- | --- | --- |\n\n## Input validation & authz\n\n## Secrets & dependencies' },
  'release-plan':    { folder: 'devops',        file: 'RELEASE.md',         template: '# Release & Rollback Plan\n\n## Release steps\n1. \n\n## Rollback steps\n1. \n\n## Monitoring & alerts\n\n## Ops runbook' },
}

interface Phase { key: string; label: string; agent: string; role: string; task: string; reads?: ArtifactSpec[]; writes?: ArtifactSpec[]; requiresApproval?: boolean }
const PHASES: Phase[] = [
  {
    key: 'REQUIREMENTS', label: 'Requirements (Copilot)', agent: PRODUCT_OWNER_AGENT, role: 'PRODUCT_OWNER',
    task: 'Write a clear Requirements & Acceptance spec for this work item:\n\n{{instance.vars.story}}\n\n' +
      'List functional requirements, acceptance criteria, and edge cases. Save it as the file deliverables/{{instance.vars.workCode}}/product-owner/REQUIREMENTS.md (create the folders if needed).',
    writes: [A.requirements],
  },
  {
    key: 'DESIGN', label: 'Design (Copilot)', agent: ARCHITECT_AGENT, role: 'ARCHITECT',
    task: 'Produce a Design Document (and an ADR if a significant decision is involved) for:\n\n{{instance.vars.story}}\n\n' +
      'Cover components, data flow, and risks. Save it as the file deliverables/{{instance.vars.workCode}}/architect/DESIGN.md (create the folders if needed).',
    reads: [A.requirements], writes: [A.design],
  },
  {
    key: 'DEVELOP', label: 'Develop (Copilot)', agent: DEVELOPER_AGENT, role: 'DEVELOPER',
    task: 'Implement this change end-to-end in the repository:\n\n{{instance.vars.story}}\n\n' +
      'Make the actual code edits, ADD or EXTEND unit tests for the new behavior, and run the tests until they pass. ' +
      'Then write a short Implementation summary (what changed and why) as the file deliverables/{{instance.vars.workCode}}/developer/IMPLEMENTATION.md (create the folders if needed).',
    reads: [A.requirements, A.design], writes: [A.implementation],
  },
  {
    key: 'QA', label: 'QA (Copilot)', agent: QA_AGENT, role: 'QA',
    task: 'Run the project test suite for the implemented change and write a concise Test Report ' +
      '(scope, results, coverage) as the file deliverables/{{instance.vars.workCode}}/qa/TEST_REPORT.md (create the folders if needed).',
    reads: [A.design, A.implementation], writes: [A.testReport],
  },
  {
    key: 'SECURITY', label: 'Security Review (Copilot)', agent: SECURITY_AGENT, role: 'SECURITY',
    task: 'Review the implemented change for security risks (input validation, authz, secrets, dependencies) ' +
      'and write a Risk Assessment as the file deliverables/{{instance.vars.workCode}}/security/RISK_ASSESSMENT.md (create the folders if needed).',
    reads: [A.design, A.implementation], writes: [A.risk],
  },
  {
    key: 'RELEASE', label: 'Release Readiness (Copilot)', agent: DEVOPS_AGENT, role: 'DEVOPS',
    task: 'Write a Release & Rollback plan and a short Ops Runbook for this change as the file deliverables/{{instance.vars.workCode}}/devops/RELEASE.md (create the folders if needed).',
    reads: [A.testReport, A.risk], writes: [A.release],
  },
]

// The signal a phase's SIGNAL_WAIT barrier parks on — unique within the run, so
// the runner can fire them all eagerly and each is matched to its own barrier.
const signalNameFor = (phase: Phase) => `copilot.${phase.key}`
// Default: every phase is human-reviewed (mirrors the server-run flow, where each
// AGENT_TASK ends AWAITING_REVIEW). Flip requiresApproval:false on a phase to drop it.
const phaseRequiresApproval = (phase: Phase) => phase.requiresApproval !== false

function artifactDefs(specs: ArtifactSpec[] | undefined, direction: 'INPUT' | 'OUTPUT'): Json {
  const prefix = direction === 'INPUT' ? 'in' : 'out'
  return (specs ?? []).map((s) => {
    const m = A_META[s.type]
    return {
      id: `${prefix}-${s.type}`,
      name: s.name,
      artifactType: s.type,
      direction,
      format: 'MARKDOWN',
      required: true,
      description: '',
      bindingPath: `deliverables.${s.type}`,
      ...(m ? { path: `deliverables/{{instance.vars.workCode}}/${m.folder}/${m.file}` } : {}),
      ...(direction === 'OUTPUT' && m ? { template: m.template } : {}),
    }
  }) as unknown as Json
}

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
    update: { edgeType: 'SEQUENTIAL', sourceNodeId: e.from, targetNodeId: e.to },
    create: { id: e.id, workflowId: WF_ID, sourceNodeId: e.from, targetNodeId: e.to, edgeType: 'SEQUENTIAL' },
  })
}

async function main(): Promise<void> {
  console.log(`Seeding "${WF_NAME}" (SIGNAL_WAIT barriers, external Copilot)…`)

  const N_START = nid(0)
  const N_CREATE_BRANCH = nid(1)
  const N_VERIFY = nid(2)
  const N_PUSH = nid(3)
  const N_RAISE_PR = nid(4)
  const N_END = nid(5)

  // Node order: START → CREATE_BRANCH → per-phase [SIGNAL_WAIT (+ APPROVAL)] →
  // VERIFIER → GIT_PUSH → RAISE_PR → END.
  const order: string[] = [N_START, N_CREATE_BRANCH]
  PHASES.forEach((phase, i) => {
    order.push(sid(i))
    if (phaseRequiresApproval(phase)) order.push(aid(i))
  })
  order.push(N_VERIFY, N_PUSH, N_RAISE_PR, N_END)

  // capabilityId: null → COMMON / platform template (capability-INDEPENDENT).
  await (prisma as any).workflow.upsert({
    where: { id: WF_ID },
    update: { name: WF_NAME, capabilityId: null, teamId: TEAM_ID, profile: 'main', workflowTypeKey: 'SDLC', metadata: { usesCopilot: true, copilotExternal: true } },
    create: {
      id: WF_ID, name: WF_NAME,
      description: 'SDLC delivered by the GitHub Copilot CLI run OFF-platform: each phase is a SIGNAL_WAIT barrier ' +
        'the exported runner signals when it finishes that phase, with a human review gate between phases.',
      status: 'PUBLISHED', currentVersion: 1, profile: 'main', workflowTypeKey: 'SDLC',
      teamId: TEAM_ID, capabilityId: null,
      metadata: { usesCopilot: true, copilotExternal: true },
    },
  })
  await (prisma as any).workflowVersion.upsert({
    where: { templateId_version: { templateId: WF_ID, version: 1 } },
    update: { graphSnapshot: { nodes: order.map((id) => ({ id })), edges: [] } },
    create: { templateId: WF_ID, version: 1, graphSnapshot: { nodes: order.map((id) => ({ id })), edges: [] } },
  })
  await (prisma as any).workflowDesignPhase.upsert({
    where: { id: PHASE_ID },
    update: { name: 'SDLC' },
    create: { id: PHASE_ID, workflowId: WF_ID, name: 'SDLC', displayOrder: 0 },
  })

  await upsertNode({ id: N_START, nodeType: 'START', label: 'Intake', x: 80 })
  // Create the work branch (wi/<code>) up-front so the external run has a branch
  // to clone/checkout and push back to. interactive:true → the run asks the
  // operator for the base branch + source mode before creating wi/<code>.
  await upsertNode({ id: N_CREATE_BRANCH, nodeType: 'CREATE_BRANCH', label: 'Create work branch', x: 80 + 200, config: { interactive: true } })

  // Emit the per-phase SIGNAL_WAIT (+ APPROVAL) nodes. Each SIGNAL_WAIT carries the
  // copilot stage config the export reads (executor:'copilot' + task + role +
  // artifact contract) AND the signalName the runner posts to. The runtime treats
  // it as a SIGNAL_WAIT (parks until signalled) — config.executor is inert here,
  // read only by the copilot-yaml export's stage filter.
  for (const [i, phase] of PHASES.entries()) {
    await upsertNode({
      id: sid(i), nodeType: 'SIGNAL_WAIT', label: `Await external: ${phase.label}`,
      x: 80 + order.indexOf(sid(i)) * 200,
      config: {
        signalName: signalNameFor(phase),
        standard: { signalName: signalNameFor(phase) },
        // ── copilot stage config, read by the copilot-yaml export ──
        executor: 'copilot', task: phase.task,
        governedStageKey: phase.key, governedAgentRole: phase.role, agentTemplateId: phase.agent,
        inputArtifacts: artifactDefs(phase.reads, 'INPUT'), outputArtifacts: artifactDefs(phase.writes, 'OUTPUT'),
        ...(DEFAULT_REPO ? { sourceType: 'github', sourceUri: DEFAULT_REPO } : {}),
      },
    })
    if (phaseRequiresApproval(phase)) {
      await upsertNode({
        id: aid(i), nodeType: 'APPROVAL', label: `Review: ${phase.label}`,
        x: 80 + order.indexOf(aid(i)) * 200,
        config: {
          assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID,
          inputArtifacts: artifactDefs(phase.writes, 'INPUT'),
        },
      })
    }
  }

  await upsertNode({
    id: N_VERIFY, nodeType: 'VERIFIER', label: 'Verify documents', x: 80 + order.indexOf(N_VERIFY) * 200,
    config: {
      startMode: 'manual',
      scope: 'ALL', requireDocuments: false,
      criteria: 'The SDLC documents (requirements, design, test report, risk assessment, release/rollback) must be complete, internally consistent with each other, and satisfy the work item\'s acceptance criteria.',
      standard: { scope: 'ALL', requireDocuments: 'false' },
    },
  })
  await upsertNode({
    id: N_PUSH, nodeType: 'GIT_PUSH', label: 'Push to remote', x: 80 + order.indexOf(N_PUSH) * 200,
    config: { startMode: 'manual', requireApproval: false, remote: 'origin', standard: { requireApproval: 'false', remote: 'origin' } },
  })
  await upsertNode({
    id: N_RAISE_PR, nodeType: 'RAISE_PR', label: 'Raise pull request', x: 80 + order.indexOf(N_RAISE_PR) * 200,
    config: { startMode: 'manual' },
  })
  await upsertNode({ id: N_END, nodeType: 'END', label: 'Done', x: 80 + order.indexOf(N_END) * 200 })

  for (let i = 0; i < order.length - 1; i++) {
    await upsertEdge({ id: eid(i), from: order[i]!, to: order[i + 1]! })
  }

  const shape = PHASES.map(p => `SIGNAL_WAIT(${p.key})${phaseRequiresApproval(p) ? '→APPROVAL' : ''}`).join(' → ')
  console.log(`✓ "${WF_NAME}" (${WF_ID}) — START → CREATE_BRANCH → ${shape} → VERIFY → GIT_PUSH → RAISE_PR → END`)
  console.log('  export a run: GET /api/workgraph/workflow-instances/:id/export/copilot-yaml — the runner POSTs')
  console.log('  /signals/copilot.<KEY> per phase; SIGNAL_WAIT barriers advance, APPROVAL gates review each phase.')
  console.log('  NOT auto-routed — pick this template explicitly in guided launch.')
}

main()
  .then(() => console.log('✓ done'))
  .catch((e) => { console.error('ERR', e?.message ?? e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
