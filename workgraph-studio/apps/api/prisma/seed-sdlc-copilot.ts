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
// Role agent templates — defaults are the REAL AgentTemplate ids that
// agent-runtime/prisma/seed.ts creates (00000000-…d1..d8), so the nodes bind to
// existing agents out of the box. (The old 885ae4d8-family defaults referenced
// templates that NO seed created → placeholder agents.) Override via env if your
// deployment uses different template ids.
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT ?? '00000000-0000-0000-0000-0000000000d7'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT ?? '00000000-0000-0000-0000-0000000000d1'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT ?? '00000000-0000-0000-0000-0000000000d2'
const QA_AGENT = process.env.SEED_QA_AGENT ?? '00000000-0000-0000-0000-0000000000d3'
const SECURITY_AGENT = process.env.SEED_SEC_AGENT ?? '00000000-0000-0000-0000-0000000000d5'
const DEVOPS_AGENT = process.env.SEED_DEVOPS_AGENT ?? '00000000-0000-0000-0000-0000000000d6'
// Default repo every copilot phase clones into its sandbox. The board's create
// form has no repoUrl field, so without a default Copilot runs in an empty dir.
// A work item that DOES set a `repoUrl` var overrides this per item.
// Optional repo fallback. This workflow is capability-INDEPENDENT: each copilot
// node resolves the repo from the WORK ITEM's capability at runtime (the
// capability's CapabilityRepository in agent-runtime). Only set a node sourceUri
// if SEED_COPILOT_REPO_URL is given, as a last-resort fallback for capabilities
// that have no linked repo.
const DEFAULT_REPO = process.env.SEED_COPILOT_REPO_URL
// Governance mode for every agentic (AGENT_TASK) node — the copilot phases run the
// governed loop with this enforcement posture. fail_closed = governance strictly
// enforced (audit-governance must be reachable). Set SEED_GOVERNANCE_MODE=fail_open
// to attempt governance but proceed if audit-gov is briefly unavailable.
const GOVERNANCE_MODE = process.env.SEED_GOVERNANCE_MODE ?? 'fail_closed'
// Bridge model (default): each copilot phase routes to the LAUNCHING USER'S laptop
// mcp-server over the outbound WS bridge (run_context.prefer_laptop=true). The box
// holds NO laptop address — the laptop dials IN to Context Fabric. CF requires a
// connected laptop and fails fast (MCP_NOT_CONNECTED) if none is paired.
// Set SEED_PREFER_LAPTOP=false to use a Direct HTTP mcp (MCP_SERVER_URL) instead.
const PREFER_LAPTOP = (process.env.SEED_PREFER_LAPTOP ?? 'true').toLowerCase() === 'true'

const WF_NAME = 'SDLC (Copilot CLI)'
const WF_ID = '3b000000-0000-0000-0000-0000000000c0'
const PHASE_ID = '3b100000-0000-0000-0000-0000000000c0'
const ROUTE_ID = '3b400000-0000-0000-0000-0000000000c0'
const id = (n: number) => `3b200000-0000-0000-0000-0000000000${n.toString(16).padStart(2, '0')}`
const eid = (n: number) => `3b300000-0000-0000-0000-0000000000${n.toString(16).padStart(2, '0')}`

type Json = Record<string, unknown>

// ── Artifact IN/OUT contract ────────────────────────────────────────────────
// Each phase declares the documents it READS (from upstream phases) and WRITES.
// `type` is the stable machine key: it is the runtime binding path (deliverables.<type>)
// AND the git filename base for the per-agent folder layout
// (deliverables/<work-id>/<agent-role>/<type>.md) added in a later slice.
// `name` is the human label shown in the designer + run view.
interface ArtifactSpec { type: string; name: string }
const A = {
  requirements:   { type: 'requirements',    name: 'Requirements & Acceptance' },
  design:         { type: 'design',           name: 'Design Document' },
  implementation: { type: 'implementation',   name: 'Implementation' },
  testReport:     { type: 'test-report',      name: 'Test Report' },
  risk:           { type: 'risk-assessment',  name: 'Risk Assessment' },
  release:        { type: 'release-plan',     name: 'Release & Rollback Plan' },
} as const

// Per-type file layout + a starter markdown template for each deliverable. This is
// what lets the composed prompt show the REAL save path
// (deliverables/<code>/<role>/<FILE>.md — not the logical binding key) and a
// skeleton the agent should follow when producing the document.
const A_META: Record<string, { folder: string; file: string; template: string }> = {
  'requirements':    { folder: 'product-owner', file: 'REQUIREMENTS.md',    template: '# Requirements & Acceptance\n\n## Summary\n\n## Functional requirements\n- \n\n## Acceptance criteria\n- \n\n## Edge cases\n- \n\n## Out of scope\n- ' },
  'design':          { folder: 'architect',     file: 'DESIGN.md',          template: '# Design Document\n\n## Overview\n\n## Components\n\n## Data flow\n\n## Interfaces & contracts\n\n## Risks & trade-offs\n\n## Alternatives considered' },
  'implementation':  { folder: 'developer',     file: 'IMPLEMENTATION.md',  template: '# Implementation Summary\n\n## What changed\n\n## Why\n\n## Files touched\n- \n\n## Tests added\n- \n\n## How to verify' },
  'test-report':     { folder: 'qa',            file: 'TEST_REPORT.md',     template: '# Test Report\n\n## Scope\n\n## Results\n\n## Coverage\n\n## Defects & follow-ups\n- ' },
  'risk-assessment': { folder: 'security',      file: 'RISK_ASSESSMENT.md', template: '# Risk Assessment\n\n## Summary\n\n## Findings\n| Severity | Issue | Recommendation |\n| --- | --- | --- |\n\n## Input validation & authz\n\n## Secrets & dependencies' },
  'release-plan':    { folder: 'devops',        file: 'RELEASE.md',         template: '# Release & Rollback Plan\n\n## Release steps\n1. \n\n## Rollback steps\n1. \n\n## Monitoring & alerts\n\n## Ops runbook' },
}

interface Phase { key: string; label: string; agent: string; role: string; task: string; reads?: ArtifactSpec[]; writes?: ArtifactSpec[] }
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

// Emit the ArtifactDef[] shape the designer (NodeInspector) + runtime
// (WorkflowRuntime.applyOutputBindings) already understand.
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
      // Real repo file path (interpolated at prompt time) — what the composer shows
      // the agent, instead of the logical bindingPath.
      ...(m ? { path: `deliverables/{{instance.vars.workCode}}/${m.folder}/${m.file}` } : {}),
      // Markdown skeleton the producing stage should follow (OUTPUT only).
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
    // Re-point endpoints on re-seed too — the positional edge ids (eid(i)) shift
    // when a node is inserted into `order` (e.g. CREATE_BRANCH at the front), so an
    // update that only touched edgeType left existing edges pointing at their OLD
    // nodes and orphaned the inserted node.
    update: { edgeType: 'SEQUENTIAL', sourceNodeId: e.from, targetNodeId: e.to },
    create: { id: e.id, workflowId: WF_ID, sourceNodeId: e.from, targetNodeId: e.to, edgeType: 'SEQUENTIAL' },
  })
}

async function main(): Promise<void> {
  console.log(`Seeding "${WF_NAME}" (AGENT_TASK chain, executor=copilot)…`)

  // Build the node id sequence: START, 6 phases, GIT_PUSH, END.
  const N_START = id(0)
  const phaseNodeIds = PHASES.map((_, i) => id(i + 1))
  const N_VERIFY = id(PHASES.length + 1)
  const N_PUSH = id(PHASES.length + 2)
  const N_RAISE_PR = id(PHASES.length + 3)
  const N_END = id(PHASES.length + 4)
  const N_CREATE_BRANCH = id(PHASES.length + 5)
  const order = [N_START, N_CREATE_BRANCH, ...phaseNodeIds, N_VERIFY, N_PUSH, N_RAISE_PR, N_END]

  // capabilityId: null → COMMON / platform template. This workflow is
  // capability-INDEPENDENT (each phase resolves the WORK ITEM's capability +
  // repo at runtime), so it must NOT be pinned to one capability. A pinned
  // capabilityId makes the guided-launch `workflow-capability-mismatch` check
  // (apps/web start preview) block launching it on any OTHER capability — e.g.
  // a freshly onboarded one — even though the workflow is designed to run on
  // any capability. Common → selectable + launchable by every capability.
  await (prisma as any).workflow.upsert({
    where: { id: WF_ID },
    update: { name: WF_NAME, capabilityId: null, teamId: TEAM_ID, profile: 'main', workflowTypeKey: 'SDLC', metadata: { usesCopilot: true } },
    create: {
      id: WF_ID, name: WF_NAME,
      description: 'SDLC delivered by the GitHub Copilot CLI: one AGENT_TASK (executor=copilot) per phase. ' +
        'context-fabric dispatches copilot_execute to the laptop mcp-server, which runs the Copilot CLI in the work-item workspace.',
      status: 'PUBLISHED', currentVersion: 1, profile: 'main', workflowTypeKey: 'SDLC',
      teamId: TEAM_ID, capabilityId: null,
      // Whole-workflow Copilot opt-in → governed agents route via the COPILOT_SDLC
      // touch point, and the UI shows the COPILOT indicator.
      metadata: { usesCopilot: true },
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
  // Create the work branch (wi/<code>) up-front, cloud-side via the GitHub
  // connector, so every phase commits onto it and the push/PR have a branch.
  // Idempotent — safe if the runtime already created it. base defaults to the
  // run's cloned branch (launch pick) then main.
  await upsertNode({ id: N_CREATE_BRANCH, nodeType: 'CREATE_BRANCH', label: 'Create work branch', x: 80 + 1 * 220, config: {} })
  for (const [i, phase] of PHASES.entries()) {
    await upsertNode({
      id: phaseNodeIds[i]!, nodeType: 'AGENT_TASK', label: phase.label, x: 80 + (i + 2) * 220,
      // executor:'copilot' → AgentTaskExecutor → run_context.executor → CF dispatches copilot_execute.
      // Capability-independent: no capabilityId pinned → AgentTaskExecutor uses
      // the work item's capability at runtime, and resolves THAT capability's
      // repo. sourceUri is only set as an explicit env fallback.
      // governedStageKey/AgentRole flow to CF's run_context (stage_key / agent_role)
      // so the copilot prompt names the role (e.g. "acting as the DEVELOPER").
      // governanceMode + useGovernedExecutor → the node runs the GOVERNED loop
      // (governance overlay + audit), connected to its role agent template.
      config: { agentTemplateId: phase.agent, task: phase.task, executor: 'copilot', governanceMode: GOVERNANCE_MODE, useGovernedExecutor: true, ...(PREFER_LAPTOP ? { preferLaptop: true } : {}), governedStageKey: phase.key, governedAgentRole: phase.role, inputArtifacts: artifactDefs(phase.reads, 'INPUT'), outputArtifacts: artifactDefs(phase.writes, 'OUTPUT'), ...(DEFAULT_REPO ? { sourceType: 'github', sourceUri: DEFAULT_REPO } : {}) },
    })
  }
  // Verifier gate before the push: run the verifier agent on EVERY document the
  // run produced (scope:'ALL') and pause the run (BLOCKED, findings in
  // _blockedByVerifier) if any fails the standards. Nothing is pushed unverified.
  await upsertNode({
    id: N_VERIFY, nodeType: 'VERIFIER', label: 'Verify documents', x: 80 + (PHASES.length + 2) * 220,
    config: {
      scope: 'ALL', requireDocuments: false,
      criteria: 'The SDLC documents (requirements, design, test report, risk assessment, release/rollback) must be complete, internally consistent with each other, and satisfy the work item\'s acceptance criteria.',
      standard: { scope: 'ALL', requireDocuments: 'false' },
    },
  })
  await upsertNode({
    id: N_PUSH, nodeType: 'GIT_PUSH', label: 'Push to remote', x: 80 + (PHASES.length + 3) * 220,
    config: { requireApproval: false, remote: 'origin', standard: { requireApproval: 'false', remote: 'origin' } },
  })
  // Open a PR from the work branch (wi/<code>) into the base branch — cloud-side
  // via the GitHub connector. Base defaults to the run's cloned branch, then main;
  // title/body default from the work item. Requires a GIT connector + (one-time)
  // the RAISE_PR enum migration applied before this seed runs.
  await upsertNode({
    id: N_RAISE_PR, nodeType: 'RAISE_PR', label: 'Raise pull request', x: 80 + (PHASES.length + 4) * 220,
    config: {},
  })
  await upsertNode({ id: N_END, nodeType: 'END', label: 'Done', x: 80 + (PHASES.length + 5) * 220 })

  for (let i = 0; i < order.length - 1; i++) {
    await upsertEdge({ id: eid(i), from: order[i]!, to: order[i + 1]! })
  }

  console.log(`✓ "${WF_NAME}" (${WF_ID}) — START → CREATE_BRANCH → ${PHASES.map(p => p.key).join(' → ')} → VERIFY → GIT_PUSH → RAISE_PR → END`)
  console.log(`  every phase node: AGENT_TASK, executor='copilot', governanceMode='${GOVERNANCE_MODE}', preferLaptop=${PREFER_LAPTOP} (bridge: laptop dials into CF); + a VERIFIER gate before push`)

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
