import type { PrismaClient } from '@prisma/client'
import { promoteWorkbenchToTables } from '../src/modules/workflow/lib/promote-workbench'

/**
 * Demo workflow + workbench + artifact seed (bare-metal / demo bring-up).
 *
 * Idempotent (fixed-UUID upserts). Creates a "full demo set":
 *   • Architect / Developer / QA agents (with externalTemplateId so the
 *     workbench loop can pin them as agent templates).
 *   • SDLC workbench workflow — the canonical 4-stage loop
 *     intake → design → develop → qa (matches blueprint.router defaultLoopDefinition).
 *   • Bug-fix workbench workflow — a distinct, leaner loop repro → fix → verify.
 *   • Three plain sample workflows (approval pipeline, branching review,
 *     parent→child CALL_WORKFLOW) so the designer/runs list isn't empty.
 *   • WorkItemRoutingPolicy rows: feature→SDLC, bug→bug-fix.
 *   • One COMPLETED blueprint session + artifacts (story brief, solution
 *     architecture, final implementation pack) so Workbench history + the
 *     Artifacts view are populated out of the box.
 *
 * Re-runnable: upserts refresh definitions; no duplicate rows.
 */

const TEAM_ID = '50000000-0000-0000-0000-000000000001' // Platform Team (seed.ts)
const CAPABILITY_ID = '11111111-2222-3333-4444-555555555555' // demo capability (00-iam.sql)
const TS = '2026-06-01T10:00:00.000Z'

const TMPL_ARCHITECT = 'tmpl-architect'
const TMPL_DEVELOPER = 'tmpl-developer'
const TMPL_QA = 'tmpl-qa'

// ── Loop definitions ─────────────────────────────────────────────────────────
// Canonical SDLC loop — mirrors defaultLoopDefinition() in blueprint.router.ts.
const SDLC_LOOP = {
  version: 1,
  name: 'SDLC capability implementation loop',
  maxLoopsPerStage: 3,
  maxTotalSendBacks: 6,
  stages: [
    {
      key: 'intake', label: 'Story Intake', agentRole: 'PRODUCT_OWNER', agentTemplateId: TMPL_ARCHITECT,
      description: 'Capture the story, acceptance criteria, scope, priority, and open questions — no repository access.',
      next: 'design', allowedSendBackTo: [], required: true, approvalRequired: true,
      contextPolicy: 'STORY_ONLY', repoAccess: false, toolPolicy: 'NONE', promptProfileKey: 'loop.stage.intake',
      expectedArtifacts: [
        { kind: 'story_brief', title: 'Story brief', required: true, format: 'MARKDOWN' },
        { kind: 'acceptance_contract', title: 'Acceptance contract', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'INTAKE-001', question: 'What business behavior must change?', required: true, freeform: true },
        { id: 'INTAKE-002', question: 'What acceptance examples prove the story is complete?', required: true, freeform: true },
      ],
    },
    {
      key: 'design', label: 'Design', agentRole: 'ARCHITECT', agentTemplateId: TMPL_ARCHITECT,
      description: 'Use the accepted story plus read-only repo evidence to produce a solution design and implementation contract.',
      next: 'develop', allowedSendBackTo: ['intake'], required: true, approvalRequired: true,
      contextPolicy: 'REPO_READ_ONLY', repoAccess: true, toolPolicy: 'READ_ONLY',
      expectedArtifacts: [
        { kind: 'solution_architecture', title: 'Solution architecture', required: true, format: 'MARKDOWN' },
        { kind: 'approved_spec_draft', title: 'Approved spec draft', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'DESIGN-001', question: 'Is the design ready for development?', required: true, freeform: true, options: [
          { label: 'Ready for development', recommended: true, impact: 'Developer can produce the code change.' },
          { label: 'Needs design rework', impact: 'Run another design pass with constraints.' },
        ] },
      ],
    },
    {
      key: 'develop', label: 'Develop', agentRole: 'DEVELOPER', agentTemplateId: TMPL_DEVELOPER,
      description: 'Produce the implementation, file changes, and code-change evidence (commits on the work branch).',
      next: 'qa', allowedSendBackTo: ['intake', 'design'], required: true, approvalRequired: true,
      contextPolicy: 'CODE_EDIT', repoAccess: true, toolPolicy: 'MUTATION',
      expectedArtifacts: [
        { kind: 'developer_task_pack', title: 'Developer task pack', required: true, format: 'MARKDOWN' },
        { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'DEV-001', question: 'Is the implementation complete enough for QA?', required: true, freeform: true, options: [
          { label: 'Ready for QA', recommended: true, impact: 'Move into QA review.' },
          { label: 'Needs developer rework', impact: 'Run another developer iteration.' },
        ] },
      ],
    },
    {
      key: 'qa', label: 'QA', agentRole: 'QA', agentTemplateId: TMPL_QA,
      description: 'Verify the change against acceptance criteria, run/inspect tests, build the traceability matrix, decide on handoff.',
      next: null, terminal: true, allowedSendBackTo: ['design', 'develop'], required: true, approvalRequired: true,
      contextPolicy: 'VERIFY_ONLY', repoAccess: true, toolPolicy: 'VERIFICATION',
      expectedArtifacts: [
        { kind: 'verification_receipt', title: 'Verification receipt', required: true, format: 'MARKDOWN' },
        { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
        { kind: 'final_handoff_notes', title: 'Final handoff notes', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'QA-001', question: 'Can this be finalized for workflow handoff?', required: true, freeform: true, options: [
          { label: 'Finalize', recommended: true, impact: 'Generate the final implementation pack.' },
          { label: 'Send back', impact: 'Return to the failing stage with feedback.' },
        ] },
      ],
    },
  ],
}

// Distinct, leaner bug-fix loop: repro → fix → verify.
const BUGFIX_LOOP = {
  version: 1,
  name: 'Bug-fix loop',
  maxLoopsPerStage: 3,
  maxTotalSendBacks: 4,
  stages: [
    {
      key: 'repro', label: 'Reproduce & Triage', agentRole: 'QA', agentTemplateId: TMPL_QA,
      description: 'Reproduce the defect against the repo, characterize it, and isolate the root cause with a failing test.',
      next: 'fix', allowedSendBackTo: [], required: true, approvalRequired: true,
      contextPolicy: 'REPO_READ_ONLY', repoAccess: true, toolPolicy: 'READ_ONLY',
      expectedArtifacts: [
        { kind: 'repro_report', title: 'Reproduction report', required: true, format: 'MARKDOWN' },
        { kind: 'root_cause', title: 'Root-cause analysis', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'REPRO-001', question: 'What is the minimal reproduction?', required: true, freeform: true },
      ],
    },
    {
      key: 'fix', label: 'Fix', agentRole: 'DEVELOPER', agentTemplateId: TMPL_DEVELOPER,
      description: 'Apply the smallest correct fix for the root cause, with code-change evidence on the work branch.',
      next: 'verify', allowedSendBackTo: ['repro'], required: true, approvalRequired: true,
      contextPolicy: 'CODE_EDIT', repoAccess: true, toolPolicy: 'MUTATION',
      expectedArtifacts: [
        { kind: 'fix_summary', title: 'Fix summary', required: true, format: 'MARKDOWN' },
        { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'FIX-001', question: 'Is the fix ready for verification?', required: true, freeform: true, options: [
          { label: 'Ready for verify', recommended: true, impact: 'Move into verification.' },
          { label: 'Needs rework', impact: 'Run another fix iteration.' },
        ] },
      ],
    },
    {
      key: 'verify', label: 'Verify', agentRole: 'QA', agentTemplateId: TMPL_QA,
      description: 'Confirm the fix resolves the defect and runs the regression suite without new failures.',
      next: null, terminal: true, allowedSendBackTo: ['fix'], required: true, approvalRequired: true,
      contextPolicy: 'VERIFY_ONLY', repoAccess: true, toolPolicy: 'VERIFICATION',
      expectedArtifacts: [
        { kind: 'verification_receipt', title: 'Verification receipt', required: true, format: 'MARKDOWN' },
        { kind: 'regression_check', title: 'Regression check', required: true, format: 'MARKDOWN' },
      ],
      questions: [
        { id: 'VERIFY-001', question: 'Is the defect resolved with no regressions?', required: true, freeform: true, options: [
          { label: 'Resolved', recommended: true, impact: 'Finalize the fix.' },
          { label: 'Send back', impact: 'Return to fix with feedback.' },
        ] },
      ],
    },
  ],
}

// ── small upsert helpers ─────────────────────────────────────────────────────
type AnyPrisma = PrismaClient
type Json = Record<string, unknown>

async function upsertNode(prisma: AnyPrisma, n: {
  id: string; workflowId: string; phaseId?: string; nodeType: string; label: string;
  config?: Json; positionX?: number; positionY?: number;
}) {
  const config = n.config ?? {}
  return (prisma as any).workflowDesignNode.upsert({
    where: { id: n.id },
    update: { label: n.label, nodeType: n.nodeType as any, config, phaseId: n.phaseId ?? null },
    create: {
      id: n.id, workflowId: n.workflowId, phaseId: n.phaseId ?? null, nodeType: n.nodeType as any,
      label: n.label, config, executionLocation: 'SERVER' as any,
      positionX: n.positionX ?? 0, positionY: n.positionY ?? 0,
    },
  })
}

async function upsertEdge(prisma: AnyPrisma, e: {
  id: string; workflowId: string; sourceNodeId: string; targetNodeId: string;
  edgeType?: string; condition?: Json; label?: string;
}) {
  return (prisma as any).workflowDesignEdge.upsert({
    where: { id: e.id },
    update: { edgeType: (e.edgeType ?? 'SEQUENTIAL') as any, condition: e.condition ?? undefined, label: e.label ?? null },
    create: {
      id: e.id, workflowId: e.workflowId, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
      edgeType: (e.edgeType ?? 'SEQUENTIAL') as any, condition: e.condition ?? undefined, label: e.label ?? null,
    },
  })
}

async function upsertWorkflowShell(prisma: AnyPrisma, w: {
  id: string; name: string; description: string; profile: string; workflowTypeKey: string;
  graphSnapshot: Json; phaseId: string; phaseName: string;
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

function workbenchConfig(goal: string, loop: typeof SDLC_LOOP | typeof BUGFIX_LOOP): Json {
  return {
    workbench: {
      profile: 'blueprint',
      goal,
      sourceType: 'localdir',
      sourceUri: 'local:/demo/reporting-service',
      sourceRef: 'main',
      capabilityId: CAPABILITY_ID,
      agentBindings: {
        architectAgentTemplateId: TMPL_ARCHITECT,
        developerAgentTemplateId: TMPL_DEVELOPER,
        qaAgentTemplateId: TMPL_QA,
      },
      loopDefinition: loop,
      outputs: { finalPackKey: 'completion_summary' },
    },
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function seedDemoWorkflows(prisma: AnyPrisma) {
  console.log('Seeding demo workflows (SDLC + bug-fix + samples + artifacts)...')

  // 1. Agents (architect / developer / qa) with externalTemplateId pins.
  // ⚠️ SOURCE-OF-TRUTH NOTE: these `systemPrompt` strings feed ONLY the legacy
  // `POST /api/agents/:id/runs` direct-run endpoint. The governed loop AND the
  // workbench resolve the OPERATIVE developer/architect/QA prompt from
  // prompt-composer (StagePromptBinding → PromptProfile → PromptLayer). Editing
  // systemPrompt here does NOT change agent behavior in any workflow/workbench
  // run — that bit us once (RCA: "developer prompt change had no effect").
  // Single source of truth for stage prompts:
  //   agent-and-tools/apps/prompt-composer/prisma/seed.ts
  const agents = [
    { id: 'a0000000-0000-0000-0000-000000000010', name: 'Architect Agent', externalTemplateId: TMPL_ARCHITECT, systemPrompt: 'You are a senior software architect. Produce clear, implementable designs grounded in the repository.' },
    { id: 'a0000000-0000-0000-0000-000000000011', name: 'Developer Agent', externalTemplateId: TMPL_DEVELOPER, systemPrompt: 'You are a senior software engineer. Make the smallest correct change with verifiable evidence. (Legacy /runs prompt only — governed/workbench behavior is set in prompt-composer.)' },
    { id: 'a0000000-0000-0000-0000-000000000012', name: 'QA Agent', externalTemplateId: TMPL_QA, systemPrompt: 'You are a QA engineer. Verify changes against acceptance criteria and guard against regressions.' },
  ]
  for (const a of agents) {
    await (prisma as any).agent.upsert({
      where: { id: a.id },
      update: { name: a.name, systemPrompt: a.systemPrompt, externalTemplateId: a.externalTemplateId, model: 'claude-sonnet-4-6' },
      create: { id: a.id, name: a.name, description: `${a.name} (demo)`, model: 'claude-sonnet-4-6', provider: 'ANTHROPIC', systemPrompt: a.systemPrompt, externalTemplateId: a.externalTemplateId, isActive: true },
    })
  }

  // 2. SDLC workbench workflow (profile=workbench, type=SDLC).
  {
    const wfId = '30000000-0000-0000-0000-000000000010'
    const phaseId = '31000000-0000-0000-0000-000000000010'
    const nStart = '32000000-0000-0000-0000-000000000010'
    const nWb = '32000000-0000-0000-0000-000000000011'
    const nEnd = '32000000-0000-0000-0000-000000000012'
    const wbConfig = workbenchConfig('Implement a capability end-to-end through the SDLC loop.', SDLC_LOOP)
    await upsertWorkflowShell(prisma, {
      id: wfId, name: 'SDLC — Capability Implementation (Workbench)',
      description: 'Staged agent SDLC loop: intake → design → develop → qa, with operator gates and artifacts.',
      profile: 'workbench', workflowTypeKey: 'SDLC',
      graphSnapshot: { nodes: [{ id: nStart, type: 'START' }, { id: nWb, type: 'WORKBENCH_TASK' }, { id: nEnd, type: 'END' }], edges: [{ from: nStart, to: nWb }, { from: nWb, to: nEnd }] },
      phaseId, phaseName: 'Workbench',
    })
    await upsertNode(prisma, { id: nStart, workflowId: wfId, phaseId, nodeType: 'START', label: 'Start', positionX: 80, positionY: 160 })
    await upsertNode(prisma, { id: nWb, workflowId: wfId, phaseId, nodeType: 'WORKBENCH_TASK', label: 'SDLC Workbench', config: wbConfig, positionX: 320, positionY: 160 })
    await upsertNode(prisma, { id: nEnd, workflowId: wfId, phaseId, nodeType: 'END', label: 'End', positionX: 600, positionY: 160 })
    await promoteWorkbenchToTables(prisma, nWb, wbConfig)
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000010', workflowId: wfId, sourceNodeId: nStart, targetNodeId: nWb })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000011', workflowId: wfId, sourceNodeId: nWb, targetNodeId: nEnd })
  }

  // 3. Bug-fix workbench workflow (profile=workbench, type=BUGFIX).
  {
    const wfId = '30000000-0000-0000-0000-000000000011'
    const phaseId = '31000000-0000-0000-0000-000000000011'
    const nStart = '32000000-0000-0000-0000-000000000020'
    const nWb = '32000000-0000-0000-0000-000000000021'
    const nEnd = '32000000-0000-0000-0000-000000000022'
    const wbConfig = workbenchConfig('Reproduce, fix, and verify a reported defect.', BUGFIX_LOOP)
    await upsertWorkflowShell(prisma, {
      id: wfId, name: 'Bug Fix (Workbench)',
      description: 'Leaner staged loop for defects: repro → fix → verify.',
      profile: 'workbench', workflowTypeKey: 'BUGFIX',
      graphSnapshot: { nodes: [{ id: nStart, type: 'START' }, { id: nWb, type: 'WORKBENCH_TASK' }, { id: nEnd, type: 'END' }], edges: [{ from: nStart, to: nWb }, { from: nWb, to: nEnd }] },
      phaseId, phaseName: 'Workbench',
    })
    await upsertNode(prisma, { id: nStart, workflowId: wfId, phaseId, nodeType: 'START', label: 'Start', positionX: 80, positionY: 160 })
    await upsertNode(prisma, { id: nWb, workflowId: wfId, phaseId, nodeType: 'WORKBENCH_TASK', label: 'Bug-fix Workbench', config: wbConfig, positionX: 320, positionY: 160 })
    await upsertNode(prisma, { id: nEnd, workflowId: wfId, phaseId, nodeType: 'END', label: 'End', positionX: 600, positionY: 160 })
    await promoteWorkbenchToTables(prisma, nWb, wbConfig)
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000020', workflowId: wfId, sourceNodeId: nStart, targetNodeId: nWb })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000021', workflowId: wfId, sourceNodeId: nWb, targetNodeId: nEnd })
  }

  // 4. Sample plain workflows (profile=main) — node-type variety.
  // 4a. Approval pipeline: START → AGENT_TASK → APPROVAL → END
  {
    const wfId = '30000000-0000-0000-0000-000000000012'
    const phaseId = '31000000-0000-0000-0000-000000000012'
    const n1 = '32000000-0000-0000-0000-000000000030', n2 = '32000000-0000-0000-0000-000000000031', n3 = '32000000-0000-0000-0000-000000000032', n4 = '32000000-0000-0000-0000-000000000033'
    await upsertWorkflowShell(prisma, {
      id: wfId, name: 'Approval Pipeline', description: 'An agent drafts an output, then a human approves it before completion.',
      profile: 'main', workflowTypeKey: 'GENERAL',
      graphSnapshot: { nodes: [n1, n2, n3, n4].map(id => ({ id })) }, phaseId, phaseName: 'Main',
    })
    await upsertNode(prisma, { id: n1, workflowId: wfId, phaseId, nodeType: 'START', label: 'Start', positionX: 80, positionY: 160 })
    await upsertNode(prisma, { id: n2, workflowId: wfId, phaseId, nodeType: 'AGENT_TASK', label: 'Draft summary', config: { agentId: 'a0000000-0000-0000-0000-000000000005' }, positionX: 300, positionY: 160 })
    await upsertNode(prisma, { id: n3, workflowId: wfId, phaseId, nodeType: 'APPROVAL', label: 'Approve', config: { assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID }, positionX: 540, positionY: 160 })
    await upsertNode(prisma, { id: n4, workflowId: wfId, phaseId, nodeType: 'END', label: 'End', positionX: 780, positionY: 160 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000030', workflowId: wfId, sourceNodeId: n1, targetNodeId: n2 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000031', workflowId: wfId, sourceNodeId: n2, targetNodeId: n3 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000032', workflowId: wfId, sourceNodeId: n3, targetNodeId: n4 })
  }
  // 4b. Branching review: START → DECISION_GATE → {approve→END, reject→HUMAN_TASK→END}
  {
    const wfId = '30000000-0000-0000-0000-000000000013'
    const phaseId = '31000000-0000-0000-0000-000000000013'
    const n1 = '32000000-0000-0000-0000-000000000040', n2 = '32000000-0000-0000-0000-000000000041', n3 = '32000000-0000-0000-0000-000000000042', n4 = '32000000-0000-0000-0000-000000000043'
    await upsertWorkflowShell(prisma, {
      id: wfId, name: 'Branching Review', description: 'A decision gate auto-approves low-risk items and routes the rest to a manual review.',
      profile: 'main', workflowTypeKey: 'GENERAL',
      graphSnapshot: { nodes: [n1, n2, n3, n4].map(id => ({ id })) }, phaseId, phaseName: 'Main',
    })
    await upsertNode(prisma, { id: n1, workflowId: wfId, phaseId, nodeType: 'START', label: 'Start', positionX: 80, positionY: 160 })
    await upsertNode(prisma, { id: n2, workflowId: wfId, phaseId, nodeType: 'DECISION_GATE', label: 'Risk gate', config: { expression: 'context.risk == "low"' }, positionX: 300, positionY: 160 })
    await upsertNode(prisma, { id: n3, workflowId: wfId, phaseId, nodeType: 'HUMAN_TASK', label: 'Manual review', config: { assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID }, positionX: 540, positionY: 280 })
    await upsertNode(prisma, { id: n4, workflowId: wfId, phaseId, nodeType: 'END', label: 'End', positionX: 780, positionY: 160 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000040', workflowId: wfId, sourceNodeId: n1, targetNodeId: n2 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000041', workflowId: wfId, sourceNodeId: n2, targetNodeId: n4, edgeType: 'CONDITIONAL', condition: { expression: 'low_risk' }, label: 'low risk' })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000042', workflowId: wfId, sourceNodeId: n2, targetNodeId: n3, edgeType: 'CONDITIONAL', condition: { expression: 'else' }, label: 'needs review' })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000043', workflowId: wfId, sourceNodeId: n3, targetNodeId: n4 })
  }
  // 4c. Parent → child: START → CALL_WORKFLOW(SDLC) → END
  {
    const wfId = '30000000-0000-0000-0000-000000000014'
    const phaseId = '31000000-0000-0000-0000-000000000014'
    const n1 = '32000000-0000-0000-0000-000000000050', n2 = '32000000-0000-0000-0000-000000000051', n3 = '32000000-0000-0000-0000-000000000052'
    await upsertWorkflowShell(prisma, {
      id: wfId, name: 'Epic → Story (Parent → Child)', description: 'An epic dispatches child stories, each running the SDLC workbench loop as a sub-workflow.',
      profile: 'main', workflowTypeKey: 'GENERAL',
      graphSnapshot: { nodes: [n1, n2, n3].map(id => ({ id })) }, phaseId, phaseName: 'Main',
    })
    await upsertNode(prisma, { id: n1, workflowId: wfId, phaseId, nodeType: 'START', label: 'Epic intake', positionX: 80, positionY: 160 })
    await upsertNode(prisma, { id: n2, workflowId: wfId, phaseId, nodeType: 'CALL_WORKFLOW', label: 'Dispatch story → SDLC', config: { workflowId: '30000000-0000-0000-0000-000000000010' }, positionX: 320, positionY: 160 })
    await upsertNode(prisma, { id: n3, workflowId: wfId, phaseId, nodeType: 'END', label: 'End', positionX: 600, positionY: 160 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000050', workflowId: wfId, sourceNodeId: n1, targetNodeId: n2 })
    await upsertEdge(prisma, { id: '33000000-0000-0000-0000-000000000051', workflowId: wfId, sourceNodeId: n2, targetNodeId: n3 })
  }

  // 5. Work-item routing policies: feature → SDLC, bug → bug-fix.
  const policies = [
    { id: '34000000-0000-0000-0000-000000000001', workItemTypeKey: 'feature', workflowTypeKey: 'SDLC', workflowId: '30000000-0000-0000-0000-000000000010' },
    { id: '34000000-0000-0000-0000-000000000002', workItemTypeKey: 'bug', workflowTypeKey: 'BUGFIX', workflowId: '30000000-0000-0000-0000-000000000011' },
  ]
  for (const p of policies) {
    await (prisma as any).workItemRoutingPolicy.upsert({
      where: { id: p.id },
      update: { workflowId: p.workflowId, workflowTypeKey: p.workflowTypeKey, isActive: true },
      create: { id: p.id, capabilityId: CAPABILITY_ID, workItemTypeKey: p.workItemTypeKey, workflowTypeKey: p.workflowTypeKey, workflowId: p.workflowId, routingMode: 'MANUAL' as any, priority: 100, isActive: true },
    })
  }

  // 6. One COMPLETED blueprint session + artifacts (populated history).
  const sessionId = 'b0000000-0000-0000-0000-000000000001'
  const accepted = (stageKey: string, label: string, role: string, tmpl: string, n = 1) => ({
    id: `b0a00000-0000-0000-0000-0000000000${n.toString().padStart(2, '0')}`,
    stageKey, stageLabel: label, agentRole: role, agentTemplateId: tmpl, attemptNumber: 1,
    status: 'PASSED', verdict: 'PASS', startedAt: TS, completedAt: TS, acceptedAt: TS, acceptedById: 'demo',
  })
  const finalPack = {
    id: 'b0f00000-0000-0000-0000-000000000001', status: 'READY_FOR_WORKFLOW_HANDOFF', generatedAt: TS,
    summary: 'Demo SDLC run: CSV export added to the reporting dashboard, verified with tests.',
    stages: SDLC_LOOP.stages.map(s => ({ stageKey: s.key, label: s.label, verdict: 'PASS', attemptNumber: 1, artifactIds: [] })),
    artifactKinds: ['story_brief', 'solution_architecture', 'final_implementation_pack'],
  }
  const loopState = {
    gateMode: 'manual', currentStageKey: 'qa', loopDefinition: SDLC_LOOP,
    stageAttempts: [
      accepted('intake', 'Story Intake', 'PRODUCT_OWNER', TMPL_ARCHITECT, 1),
      accepted('design', 'Design', 'ARCHITECT', TMPL_ARCHITECT, 2),
      accepted('develop', 'Develop', 'DEVELOPER', TMPL_DEVELOPER, 3),
      accepted('qa', 'QA', 'QA', TMPL_QA, 4),
    ],
    reviewEvents: [], decisionAnswers: [], finalPack,
  }
  await (prisma as any).blueprintSession.upsert({
    where: { id: sessionId },
    update: { status: 'COMPLETED', metadata: loopState as any },
    create: {
      id: sessionId, goal: 'Add CSV export to the reporting dashboard', sourceType: 'LOCALDIR' as any,
      sourceUri: 'local:/demo/reporting-service', sourceRef: 'main', capabilityId: CAPABILITY_ID,
      architectAgentTemplateId: TMPL_ARCHITECT, developerAgentTemplateId: TMPL_DEVELOPER, qaAgentTemplateId: TMPL_QA,
      status: 'COMPLETED' as any, includeGlobs: [], excludeGlobs: [], metadata: loopState as any,
    },
  })
  const artifacts = [
    { id: 'b1000000-0000-0000-0000-000000000001', kind: 'story_brief', title: 'Story brief — CSV export', stage: 'ARCHITECT', content: '# Story brief\n\nAs an analyst I want to export the dashboard table as CSV so I can share it.\n\n## Acceptance\n- A "Download CSV" button is present on the report view.\n- The CSV matches the on-screen rows + columns.' },
    { id: 'b1000000-0000-0000-0000-000000000002', kind: 'solution_architecture', title: 'Solution architecture — CSV export', stage: 'ARCHITECT', content: '# Solution architecture\n\nAdd a `GET /reports/:id/export.csv` endpoint that streams the same query the table uses, and a client button that hits it. No schema change.' },
    { id: 'b1000000-0000-0000-0000-000000000003', kind: 'final_implementation_pack', title: 'Final implementation pack', stage: 'QA', content: '# Final Implementation Pack\n\nStatus: READY_FOR_WORKFLOW_HANDOFF\n\n## Accepted Stages\n- Story Intake: PASS\n- Design: PASS\n- Develop: PASS\n- QA: PASS\n\n## Summary\nCSV export shipped and verified (unit + e2e).' },
  ]
  for (const a of artifacts) {
    await (prisma as any).blueprintArtifact.upsert({
      where: { id: a.id },
      update: { title: a.title, content: a.content, kind: a.kind, stage: a.stage as any },
      create: { id: a.id, sessionId, kind: a.kind, title: a.title, stage: a.stage as any, content: a.content, payload: { stageKey: a.stage === 'QA' ? 'qa' : 'design', version: 1 } as any },
    })
  }

  console.log('  ✓ demo workflows: SDLC + Bug Fix + Epic→Story + Approval Pipeline + Branching Review + routing policies + 1 completed session (3 artifacts)')
}
