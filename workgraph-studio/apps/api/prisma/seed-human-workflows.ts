import type { PrismaClient } from '@prisma/client'

/**
 * Human-only workflow seed (bare-metal / demo bring-up).
 *
 * Two AGENT-FREE workflows — no AGENT_TASK / WORKBENCH_TASK / TOOL_REQUEST.
 * They exercise the human + flow-control node palette and carry real task
 * FORMS (config.formWidgets), so the designer + launch list show a pure
 * "human loop" that a person can click all the way through:
 *
 *   A. Access Request (Human Approval) — simple linear loop:
 *        START → HUMAN_TASK(form) → APPROVAL(form) → CONSUMABLE_CREATION(form) → END
 *
 *   B. Change Request (Full Human Loop) — branching + parallel + timer:
 *        START → HUMAN_TASK(intake form) → SET_CONTEXT → DECISION_GATE
 *          ├─(risk == low, fast-track)──────────────────────────┐
 *          └─(default: needs review) → PARALLEL_FORK             │
 *                ├→ HUMAN_TASK "Security review"(form) ─┐        │
 *                └→ HUMAN_TASK "CAB review"(form) ──────┴→ PARALLEL_JOIN ┐
 *                                                                       ▼
 *        APPROVAL(form) ◄───────────────────────────────────────────────┘
 *          → TIMER("await change window") → CONSUMABLE_CREATION(form) → END
 *
 * Node types covered across the two: START, END, HUMAN_TASK, APPROVAL,
 * CONSUMABLE_CREATION, SET_CONTEXT, DECISION_GATE, PARALLEL_FORK, PARALLEL_JOIN,
 * TIMER. Edge types: SEQUENTIAL, CONDITIONAL, PARALLEL_SPLIT, PARALLEL_JOIN.
 *
 * Idempotent (fixed-UUID upserts). Runs from seed.ts AFTER seedDemoWorkflows so
 * the consumable types (seed.ts) already exist. Re-runnable; no duplicate rows.
 */

const TEAM_ID = '50000000-0000-0000-0000-000000000001' // Platform Team (seed.ts)
const CAPABILITY_ID = '11111111-2222-3333-4444-555555555555' // demo capability (00-iam.sql)

// Real ConsumableTypes seeded in seed.ts (must exist before this runs).
const CT_APPROVAL_DECISION = '20000000-0000-0000-0000-000000000008' // ApprovalDecision
const CT_OUTCOME_REPORT = '20000000-0000-0000-0000-000000000009' // OutcomeReport

type AnyPrisma = PrismaClient
type Json = Record<string, unknown>

// Compact ArtifactDef builder for per-node IN/OUT documents (the shape the run-view
// READS/WRITES strip + WorkflowRuntime.applyOutputBindings understand).
function aDef(name: string, artifactType: string, direction: 'INPUT' | 'OUTPUT', required = true, format: 'JSON' | 'MARKDOWN' | 'TEXT' = 'JSON'): Json {
  return {
    id: `${direction === 'INPUT' ? 'in' : 'out'}-${artifactType}`,
    name, artifactType, direction, format, required, description: '',
    bindingPath: `deliverables.${artifactType}`,
  }
}

// ── Form widget builders ─────────────────────────────────────────────────────
// Mirrors FormWidget in apps/web/src/features/forms/widgets/types.ts. Widgets
// render on HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION nodes at run time.
type Widget = Json & { id: string; type: string }
const heading = (id: string, label: string, level: 1 | 2 | 3 = 2): Widget => ({ id, type: 'HEADING', label, level })
const instructions = (id: string, content: string): Widget => ({ id, type: 'INSTRUCTIONS', content })
const divider = (id: string): Widget => ({ id, type: 'DIVIDER' })
const shortText = (id: string, key: string, label: string, required = false, placeholder?: string): Widget =>
  ({ id, type: 'SHORT_TEXT', key, label, required, ...(placeholder ? { placeholder } : {}) })
const longText = (id: string, key: string, label: string, required = false, rows = 4): Widget =>
  ({ id, type: 'LONG_TEXT', key, label, required, rows })
const email = (id: string, key: string, label: string, required = false): Widget => ({ id, type: 'EMAIL', key, label, required })
const url = (id: string, key: string, label: string, required = false): Widget => ({ id, type: 'URL', key, label, required })
const dateField = (id: string, key: string, label: string, required = false): Widget => ({ id, type: 'DATE', key, label, required })
const boolean = (id: string, key: string, label: string, required = false): Widget =>
  ({ id, type: 'BOOLEAN', key, label, required, defaultValue: false })
const signature = (id: string, key: string, label: string, required = true): Widget => ({ id, type: 'SIGNATURE', key, label, required })
const select = (id: string, key: string, label: string, options: string[], required = false): Widget =>
  ({ id, type: 'SELECT', key, label, required, options: options.map(o => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''), label: o })) })
const multiSelect = (id: string, key: string, label: string, options: string[], required = false): Widget =>
  ({ id, type: 'MULTI_SELECT', key, label, required, options: options.map(o => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''), label: o })) })
const checklist = (id: string, key: string, label: string, items: string[]): Widget =>
  ({ id, type: 'CHECKLIST', key, label, items: items.map((label, i) => ({ id: `${id}-i${i}`, label })) })

// ── Upsert helpers (same shape as seed-demo-workflows.ts) ────────────────────
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
  id: string; name: string; description: string; graphSnapshot: Json; phaseId: string; phaseName: string;
}) {
  await (prisma as any).workflow.upsert({
    where: { id: w.id },
    update: { name: w.name, description: w.description, profile: 'main', workflowTypeKey: 'GENERAL', capabilityId: CAPABILITY_ID, teamId: TEAM_ID },
    create: {
      id: w.id, name: w.name, description: w.description, status: 'PUBLISHED', currentVersion: 1,
      profile: 'main', workflowTypeKey: 'GENERAL', teamId: TEAM_ID, capabilityId: CAPABILITY_ID,
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

const HUMAN_ASSIGN = { assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID }

// ── main ─────────────────────────────────────────────────────────────────────
export async function seedHumanWorkflows(prisma: AnyPrisma) {
  console.log('Seeding human-only workflows (Access Request + Change Request)...')

  // ═══ Workflow A — Access Request (Human Approval) ══════════════════════════
  {
    const wfId = '3a000000-0000-0000-0000-000000000001'
    const phaseId = '3b000000-0000-0000-0000-000000000001'
    const nStart = '3c000000-0000-0000-0000-0000000000a1'
    const nReq = '3c000000-0000-0000-0000-0000000000a2'
    const nApp = '3c000000-0000-0000-0000-0000000000a3'
    const nRec = '3c000000-0000-0000-0000-0000000000a4'
    const nEnd = '3c000000-0000-0000-0000-0000000000a5'

    await upsertWorkflowShell(prisma, {
      id: wfId,
      name: 'Access Request (Human Approval)',
      description: 'A person requests access via a form, a manager approves it, and the grant is recorded. No agents — a pure human approval loop.',
      graphSnapshot: {
        nodes: [
          { id: nStart, type: 'START' }, { id: nReq, type: 'HUMAN_TASK' }, { id: nApp, type: 'APPROVAL' },
          { id: nRec, type: 'CONSUMABLE_CREATION' }, { id: nEnd, type: 'END' },
        ],
        edges: [{ from: nStart, to: nReq }, { from: nReq, to: nApp }, { from: nApp, to: nRec }, { from: nRec, to: nEnd }],
      },
      phaseId, phaseName: 'Access Request',
    })

    await upsertNode(prisma, { id: nStart, workflowId: wfId, phaseId, nodeType: 'START', label: 'Request received', positionX: 80, positionY: 200 })
    await upsertNode(prisma, {
      id: nReq, workflowId: wfId, phaseId, nodeType: 'HUMAN_TASK', label: 'Submit access request', positionX: 300, positionY: 200,
      config: {
        ...HUMAN_ASSIGN,
        outputArtifacts: [aDef('Access Request Form', 'access-request', 'OUTPUT')],
        formWidgets: [
          heading('a2-h', 'Access request details'),
          instructions('a2-i', 'Fill in what access you need and why. A manager will review this before anything is granted.'),
          shortText('a2-name', 'requester_name', 'Requester name', true),
          email('a2-email', 'requester_email', 'Work email', true),
          select('a2-system', 'system', 'System / application', ['CRM', 'Data Warehouse', 'Git / Source Control', 'Finance Portal', 'Production Console'], true),
          select('a2-level', 'access_level', 'Access level', ['Read-only', 'Contributor', 'Admin'], true),
          longText('a2-just', 'justification', 'Business justification', true, 4),
          dateField('a2-by', 'needed_by', 'Needed by'),
          boolean('a2-ack', 'policy_ack', 'I have read and accept the acceptable-use policy', true),
        ],
      },
    })
    await upsertNode(prisma, {
      id: nApp, workflowId: wfId, phaseId, nodeType: 'APPROVAL', label: 'Manager approval', positionX: 540, positionY: 200,
      config: {
        ...HUMAN_ASSIGN,
        inputArtifacts: [aDef('Access Request Form', 'access-request', 'INPUT')],
        outputArtifacts: [aDef('Manager Decision', 'manager-decision', 'OUTPUT')],
        formWidgets: [
          heading('a3-h', 'Manager decision'),
          instructions('a3-i', 'Review the request above, then approve or reject with a note.'),
          select('a3-dec', 'decision', 'Decision', ['Approve', 'Reject'], true),
          longText('a3-c', 'comments', 'Comments', false, 3),
          signature('a3-sig', 'approver_signature', 'Approver signature', true),
        ],
      },
    })
    await upsertNode(prisma, {
      id: nRec, workflowId: wfId, phaseId, nodeType: 'CONSUMABLE_CREATION', label: 'Record access grant', positionX: 780, positionY: 200,
      config: {
        ...HUMAN_ASSIGN,
        inputArtifacts: [aDef('Manager Decision', 'manager-decision', 'INPUT')],
        outputArtifacts: [aDef('Access Grant Record', 'access-grant', 'OUTPUT')],
        consumableTypeId: CT_APPROVAL_DECISION,
        formWidgets: [
          heading('a4-h', 'Access grant record'),
          shortText('a4-tk', 'ticket_ref', 'Provisioning ticket reference'),
          select('a4-st', 'provisioning_status', 'Provisioning status', ['Provisioned', 'Pending', 'Denied'], true),
          longText('a4-n', 'notes', 'Notes', false, 3),
        ],
      },
    })
    await upsertNode(prisma, { id: nEnd, workflowId: wfId, phaseId, nodeType: 'END', label: 'Access closed', positionX: 1000, positionY: 200 })

    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000a1', workflowId: wfId, sourceNodeId: nStart, targetNodeId: nReq })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000a2', workflowId: wfId, sourceNodeId: nReq, targetNodeId: nApp })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000a3', workflowId: wfId, sourceNodeId: nApp, targetNodeId: nRec })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000a4', workflowId: wfId, sourceNodeId: nRec, targetNodeId: nEnd })
  }

  // ═══ Workflow B — Change Request (Full Human Loop) ═════════════════════════
  {
    const wfId = '3a000000-0000-0000-0000-000000000002'
    const phaseId = '3b000000-0000-0000-0000-000000000002'
    const nStart = '3c000000-0000-0000-0000-0000000000b1'
    const nIntake = '3c000000-0000-0000-0000-0000000000b2'
    const nSetCtx = '3c000000-0000-0000-0000-0000000000b3'
    const nGate = '3c000000-0000-0000-0000-0000000000b4'
    const nFork = '3c000000-0000-0000-0000-0000000000b5'
    const nSec = '3c000000-0000-0000-0000-0000000000b6'
    const nCab = '3c000000-0000-0000-0000-0000000000b7'
    const nJoin = '3c000000-0000-0000-0000-0000000000b8'
    const nApp = '3c000000-0000-0000-0000-0000000000b9'
    const nTimer = '3c000000-0000-0000-0000-0000000000ba'
    const nRec = '3c000000-0000-0000-0000-0000000000bb'
    const nEnd = '3c000000-0000-0000-0000-0000000000bc'

    await upsertWorkflowShell(prisma, {
      id: wfId,
      name: 'Change Request (Full Human Loop)',
      description: 'A change is submitted, risk-assessed, and either fast-tracked (low risk) or sent through parallel Security + CAB reviews, then finally approved, scheduled with a timer, and recorded. Entirely human — no agents.',
      graphSnapshot: {
        nodes: [
          { id: nStart, type: 'START' }, { id: nIntake, type: 'HUMAN_TASK' }, { id: nSetCtx, type: 'SET_CONTEXT' },
          { id: nGate, type: 'DECISION_GATE' }, { id: nFork, type: 'PARALLEL_FORK' }, { id: nSec, type: 'HUMAN_TASK' },
          { id: nCab, type: 'HUMAN_TASK' }, { id: nJoin, type: 'PARALLEL_JOIN' }, { id: nApp, type: 'APPROVAL' },
          { id: nTimer, type: 'TIMER' }, { id: nRec, type: 'CONSUMABLE_CREATION' }, { id: nEnd, type: 'END' },
        ],
        edges: [
          { from: nStart, to: nIntake }, { from: nIntake, to: nSetCtx }, { from: nSetCtx, to: nGate },
          { from: nGate, to: nApp, label: 'low risk' }, { from: nGate, to: nFork, label: 'needs review' },
          { from: nFork, to: nSec }, { from: nFork, to: nCab }, { from: nSec, to: nJoin }, { from: nCab, to: nJoin },
          { from: nJoin, to: nApp }, { from: nApp, to: nTimer }, { from: nTimer, to: nRec }, { from: nRec, to: nEnd },
        ],
      },
      phaseId, phaseName: 'Change Management',
    })

    await upsertNode(prisma, { id: nStart, workflowId: wfId, phaseId, nodeType: 'START', label: 'Change intake', positionX: 60, positionY: 320 })
    await upsertNode(prisma, {
      id: nIntake, workflowId: wfId, phaseId, nodeType: 'HUMAN_TASK', label: 'Submit change request', positionX: 260, positionY: 320,
      config: {
        ...HUMAN_ASSIGN,
        outputArtifacts: [aDef('Change Request', 'change-request', 'OUTPUT')],
        formWidgets: [
          heading('b2-h', 'Change request'),
          instructions('b2-i', 'Describe the change, its risk, and how you would roll it back. Low-risk changes are fast-tracked; anything else goes to Security + CAB review.'),
          shortText('b2-title', 'change_title', 'Change title', true),
          longText('b2-desc', 'description', 'Description & scope', true, 4),
          select('b2-risk', 'risk', 'Risk level', ['Low', 'Medium', 'High'], true),
          multiSelect('b2-sys', 'affected_systems', 'Affected systems', ['CRM', 'Data Warehouse', 'Billing', 'Auth / SSO', 'Networking', 'Production Database']),
          longText('b2-rb', 'rollback_plan', 'Rollback plan', true, 3),
          dateField('b2-win', 'change_window', 'Target change window'),
          checklist('b2-pre', 'pre_checks', 'Pre-implementation checks', ['Backup verified', 'Stakeholders notified', 'Tested in staging']),
        ],
      },
    })
    await upsertNode(prisma, {
      id: nSetCtx, workflowId: wfId, phaseId, nodeType: 'SET_CONTEXT', label: 'Classify change', positionX: 470, positionY: 320,
      config: { assignments: [{ path: 'stage', value: 'risk_assessment' }] },
    })
    await upsertNode(prisma, {
      id: nGate, workflowId: wfId, phaseId, nodeType: 'DECISION_GATE', label: 'Risk assessment gate', positionX: 660, positionY: 320,
      config: { description: 'Low risk → fast-track to approval; otherwise fan out to Security + CAB review.' },
    })
    await upsertNode(prisma, { id: nFork, workflowId: wfId, phaseId, nodeType: 'PARALLEL_FORK', label: 'Fan out reviews', positionX: 860, positionY: 440 })
    await upsertNode(prisma, {
      id: nSec, workflowId: wfId, phaseId, nodeType: 'HUMAN_TASK', label: 'Security review', positionX: 1060, positionY: 360,
      config: {
        ...HUMAN_ASSIGN,
        inputArtifacts: [aDef('Change Request', 'change-request', 'INPUT')],
        outputArtifacts: [aDef('Security Findings', 'security-findings', 'OUTPUT')],
        formWidgets: [
          heading('b6-h', 'Security review'),
          longText('b6-find', 'security_findings', 'Security findings', true, 4),
          select('b6-sev', 'severity', 'Severity', ['None', 'Low', 'Medium', 'High', 'Critical'], true),
          longText('b6-mit', 'mitigations', 'Required mitigations', false, 3),
          signature('b6-sig', 'security_signoff', 'Reviewer sign-off', true),
        ],
      },
    })
    await upsertNode(prisma, {
      id: nCab, workflowId: wfId, phaseId, nodeType: 'HUMAN_TASK', label: 'Change Advisory Board review', positionX: 1060, positionY: 520,
      config: {
        ...HUMAN_ASSIGN,
        inputArtifacts: [aDef('Change Request', 'change-request', 'INPUT')],
        outputArtifacts: [aDef('CAB Decision', 'cab-decision', 'OUTPUT')],
        formWidgets: [
          heading('b7-h', 'CAB review'),
          select('b7-dec', 'cab_decision', 'CAB decision', ['Approve', 'Approve with conditions', 'Reject'], true),
          longText('b7-cond', 'cab_conditions', 'Conditions / notes', false, 3),
          checklist('b7-cl', 'cab_checklist', 'CAB checklist', ['Rollback plan adequate', 'Change window acceptable', 'Comms plan in place']),
        ],
      },
    })
    await upsertNode(prisma, {
      id: nJoin, workflowId: wfId, phaseId, nodeType: 'PARALLEL_JOIN', label: 'Consolidate reviews', positionX: 1280, positionY: 440,
      config: {
        expected_joins: 2,
        inputArtifacts: [aDef('Security Findings', 'security-findings', 'INPUT'), aDef('CAB Decision', 'cab-decision', 'INPUT')],
        outputArtifacts: [aDef('Consolidated Review', 'review-consolidation', 'OUTPUT')],
      },
    })
    await upsertNode(prisma, {
      id: nApp, workflowId: wfId, phaseId, nodeType: 'APPROVAL', label: 'Final change approval', positionX: 1480, positionY: 320,
      config: {
        ...HUMAN_ASSIGN,
        inputArtifacts: [aDef('Change Request', 'change-request', 'INPUT'), aDef('Consolidated Review', 'review-consolidation', 'INPUT', false)],
        outputArtifacts: [aDef('Final Approval', 'final-approval', 'OUTPUT')],
        formWidgets: [
          heading('b9-h', 'Final approval'),
          instructions('b9-i', 'Authorize the change to proceed to its scheduled window, or reject it.'),
          select('b9-dec', 'decision', 'Decision', ['Approve', 'Reject'], true),
          longText('b9-c', 'comments', 'Approver comments', false, 3),
          signature('b9-sig', 'authorizer_signature', 'Authorizing signature', true),
        ],
      },
    })
    await upsertNode(prisma, {
      id: nTimer, workflowId: wfId, phaseId, nodeType: 'TIMER', label: 'Await change window', positionX: 1680, positionY: 320,
      config: { duration: '30s', description: 'Holds the run until the change window opens (demo: 30s).' },
    })
    await upsertNode(prisma, {
      id: nRec, workflowId: wfId, phaseId, nodeType: 'CONSUMABLE_CREATION', label: 'Record change outcome', positionX: 1880, positionY: 320,
      config: {
        ...HUMAN_ASSIGN,
        inputArtifacts: [aDef('Final Approval', 'final-approval', 'INPUT')],
        outputArtifacts: [aDef('Change Outcome', 'change-outcome', 'OUTPUT')],
        consumableTypeId: CT_OUTCOME_REPORT,
        formWidgets: [
          heading('bb-h', 'Change outcome'),
          longText('bb-sum', 'implementation_summary', 'Implementation summary', true, 4),
          select('bb-out', 'outcome', 'Outcome', ['Implemented', 'Rolled back', 'Cancelled'], true),
          url('bb-ev', 'evidence_url', 'Evidence link'),
          checklist('bb-cl', 'closure_checklist', 'Closure checklist', ['Change verified in production', 'Monitoring confirmed stable', 'Ticket closed']),
        ],
      },
    })
    await upsertNode(prisma, { id: nEnd, workflowId: wfId, phaseId, nodeType: 'END', label: 'Change closed', positionX: 2080, positionY: 320 })

    // Edges
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b1', workflowId: wfId, sourceNodeId: nStart, targetNodeId: nIntake })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b2', workflowId: wfId, sourceNodeId: nIntake, targetNodeId: nSetCtx })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b3', workflowId: wfId, sourceNodeId: nSetCtx, targetNodeId: nGate })
    // DECISION_GATE (XOR): low-risk fast-track is the conditional branch; the
    // full-review path is the DEFAULT so an unset/other risk never dead-ends.
    await upsertEdge(prisma, {
      id: '3d000000-0000-0000-0000-0000000000b4', workflowId: wfId, sourceNodeId: nGate, targetNodeId: nApp,
      edgeType: 'CONDITIONAL', label: 'Low risk — fast track',
      condition: { logic: 'AND', priority: 0, conditions: [{ left: 'context.risk', op: '==', right: 'low' }] },
    })
    await upsertEdge(prisma, {
      id: '3d000000-0000-0000-0000-0000000000b5', workflowId: wfId, sourceNodeId: nGate, targetNodeId: nFork,
      edgeType: 'CONDITIONAL', label: 'Needs full review',
      condition: { isDefault: true, priority: 1 },
    })
    // PARALLEL_FORK → both reviews (PARALLEL_SPLIT fires all)
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b6', workflowId: wfId, sourceNodeId: nFork, targetNodeId: nSec, edgeType: 'PARALLEL_SPLIT' })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b7', workflowId: wfId, sourceNodeId: nFork, targetNodeId: nCab, edgeType: 'PARALLEL_SPLIT' })
    // reviews → PARALLEL_JOIN (waits for expected_joins=2)
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b8', workflowId: wfId, sourceNodeId: nSec, targetNodeId: nJoin, edgeType: 'PARALLEL_JOIN' })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000b9', workflowId: wfId, sourceNodeId: nCab, targetNodeId: nJoin, edgeType: 'PARALLEL_JOIN' })
    // join → approval (also the merge point for the fast-track branch)
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000ba', workflowId: wfId, sourceNodeId: nJoin, targetNodeId: nApp })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000bb', workflowId: wfId, sourceNodeId: nApp, targetNodeId: nTimer })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000bc', workflowId: wfId, sourceNodeId: nTimer, targetNodeId: nRec })
    await upsertEdge(prisma, { id: '3d000000-0000-0000-0000-0000000000bd', workflowId: wfId, sourceNodeId: nRec, targetNodeId: nEnd })
  }

  console.log('  ✓ human workflows: Access Request (Human Approval) + Change Request (Full Human Loop)')
}
