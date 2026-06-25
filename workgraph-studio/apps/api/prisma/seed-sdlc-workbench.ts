/**
 * Proper SDLC workflow that produces the right catalog artifacts (M102).
 *
 * A standalone workbench-loop template (profile='workbench') whose six stages
 * each declare `expectedArtifacts` linked to the seeded ArtifactTemplate
 * catalog (seed-artifact-templates.ts). The workbench's createLoopStageArtifacts
 * path generates + captures + renders one artifact per declared kind, and —
 * because each artifact carries a `templateId` — buildLoopStageVars injects the
 * template's section skeleton into the agent prompt (M102 B-runtime), so the
 * generated docs follow the catalog structure (Design Doc → Components/Risks,
 * Test Report → Scope/Results/Coverage, etc.).
 *
 *   Requirements → Design → Develop → QA → Security → Release(terminal)
 *
 * Catalog mapping:
 *   Requirements → tmpl-requirements-spec     (requirements_spec)
 *   Design       → tmpl-design-document + tmpl-adr
 *   Develop      → developer_task_pack + actual_code_change (real MCP/git edits)
 *   QA           → tmpl-test-report           (test_report)
 *   Security     → tmpl-risk-assessment       (risk_assessment)
 *   Release      → tmpl-release-rollback-plan + tmpl-ops-runbook
 *
 * Idempotent: looked up by name, deleted+recreated. Run:
 *   npx tsx prisma/seed-sdlc-workbench.ts
 * (Prereq: run seed-artifact-templates.ts so the catalog templates exist.)
 */
import { PrismaClient, Prisma, type NodeType } from '@prisma/client'
import { promoteWorkbenchToTables } from '../src/modules/workflow/lib/promote-workbench'

const prisma = new PrismaClient()

// Default to the demo capability + Platform Team (created by prisma/seed.ts), matching
// seed-sdlc-main.ts and seed-sdlc-copilot.ts. The previous defaults referenced a
// capability/team that the base seed never creates, so a fresh seed hit an FK error.
const CAPABILITY_ID = process.env.SEED_CAPABILITY_ID ?? '11111111-2222-3333-4444-555555555555'
const TEAM_ID = process.env.SEED_TEAM_ID ?? '50000000-0000-0000-0000-000000000001'
// Baseline role agent templates seeded by agent-runtime (00000000-…d1..d8). These are
// the ids that actually exist in the agent_template store; aligned with
// seed-sdlc-copilot.ts so the loop's per-stage agents resolve instead of dangling.
// Override with SEED_*_AGENT for capability-specific agents per deployment.
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT ?? '00000000-0000-0000-0000-0000000000d7'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT ?? '00000000-0000-0000-0000-0000000000d1'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT ?? '00000000-0000-0000-0000-0000000000d2'
const QA_AGENT = process.env.SEED_QA_AGENT ?? '00000000-0000-0000-0000-0000000000d3'
const SECURITY_AGENT = process.env.SEED_SEC_AGENT ?? '00000000-0000-0000-0000-0000000000d5'
const DEVOPS_AGENT = process.env.SEED_DEVOPS_AGENT ?? '00000000-0000-0000-0000-0000000000d6'

const SDLC_NAME = 'SDLC implementation loop'

interface ArtifactSpec { kind: string; title: string; format: string; required: boolean; templateId?: string }
interface StageSpec {
  key: string; label: string; agentRole: string; agentTemplateId: string
  toolPolicy: string; contextPolicy: string; repoAccess: boolean
  terminal: boolean; approvalRequired: boolean
  expectedArtifacts: ArtifactSpec[]; sendBackTo: string[]
  // Per-stage step budget (overrides the runtime default, e.g. 28 for a
  // mutating dev stage). Develop needs more headroom because the agent must
  // implement AND add/run unit tests AND self-review in one stage.
  limits?: { maxSteps?: number }
}

const SDLC_STAGES: StageSpec[] = [
  {
    key: 'REQUIREMENTS', label: 'Requirements', agentRole: 'PRODUCT_OWNER', agentTemplateId: PRODUCT_OWNER_AGENT,
    toolPolicy: 'NONE', contextPolicy: 'STORY_ONLY', repoAccess: false, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'requirements_spec', title: 'Requirements & Acceptance Spec', format: 'MARKDOWN', required: true, templateId: 'tmpl-requirements-spec' },
    ],
    sendBackTo: [],
  },
  {
    key: 'DESIGN', label: 'Design', agentRole: 'ARCHITECT', agentTemplateId: ARCHITECT_AGENT,
    toolPolicy: 'READ_ONLY', contextPolicy: 'REPO_READ_ONLY', repoAccess: true, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'design_document', title: 'Design Document', format: 'MARKDOWN', required: true, templateId: 'tmpl-design-document' },
      { kind: 'adr', title: 'Architecture Decision Record', format: 'MARKDOWN', required: false, templateId: 'tmpl-adr' },
    ],
    sendBackTo: ['REQUIREMENTS'],
  },
  {
    key: 'DEVELOP', label: 'Develop', agentRole: 'DEVELOPER', agentTemplateId: DEVELOPER_AGENT,
    toolPolicy: 'MUTATION', contextPolicy: 'CODE_EDIT', repoAccess: true, terminal: false, approvalRequired: true,
    // Implement + add/extend unit tests + run them + self-review in one stage
    // needs well above the default ~40-step dev budget (WORKBENCH_DEVELOPER_MAX_STEPS).
    limits: { maxSteps: 160 },
    expectedArtifacts: [
      { kind: 'developer_task_pack', title: 'Developer task pack', format: 'MARKDOWN', required: true },
      { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', format: 'MARKDOWN', required: true },
      // Tests are written in Develop (not QA): the developer must add/extend unit
      // tests for the new behavior AND run them green before this stage completes.
      { kind: 'unit_tests', title: 'Unit Test Cases (added/updated) + passing run', format: 'MARKDOWN', required: true },
    ],
    sendBackTo: ['REQUIREMENTS', 'DESIGN'],
  },
  {
    key: 'QA', label: 'QA', agentRole: 'QA', agentTemplateId: QA_AGENT,
    toolPolicy: 'VERIFICATION', contextPolicy: 'VERIFY_ONLY', repoAccess: true, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'test_report', title: 'Test Report', format: 'MARKDOWN', required: true, templateId: 'tmpl-test-report' },
    ],
    sendBackTo: ['DESIGN', 'DEVELOP'],
  },
  {
    key: 'SECURITY', label: 'Security Review', agentRole: 'SECURITY', agentTemplateId: SECURITY_AGENT,
    toolPolicy: 'READ_ONLY', contextPolicy: 'EVIDENCE_REVIEW', repoAccess: true, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'risk_assessment', title: 'Risk Assessment', format: 'MARKDOWN', required: true, templateId: 'tmpl-risk-assessment' },
    ],
    sendBackTo: ['DESIGN', 'DEVELOP'],
  },
  {
    key: 'RELEASE', label: 'Release Readiness', agentRole: 'DEVOPS', agentTemplateId: DEVOPS_AGENT,
    toolPolicy: 'READ_ONLY', contextPolicy: 'EVIDENCE_REVIEW', repoAccess: true, terminal: true, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'release_rollback_plan', title: 'Release & Rollback Plan', format: 'MARKDOWN', required: true, templateId: 'tmpl-release-rollback-plan' },
      { kind: 'ops_runbook', title: 'Operations Runbook', format: 'MARKDOWN', required: false, templateId: 'tmpl-ops-runbook' },
    ],
    sendBackTo: ['DEVELOP', 'QA', 'SECURITY'],
  },
]

async function main(): Promise<void> {
  console.log(`Seeding "${SDLC_NAME}" (proper SDLC workbench loop with catalog artifacts)…`)
  const prior = await prisma.workflow.findFirst({ where: { name: SDLC_NAME } })
  if (prior) {
    await prisma.workflowVersion.deleteMany({ where: { templateId: prior.id } })
    await prisma.workflow.delete({ where: { id: prior.id } })
    console.log(`✓ removed prior (${prior.id})`)
  }
  const staleDefinitions = await prisma.$executeRaw`
    DELETE FROM workbench_definitions d
    WHERE d.name = ${SDLC_NAME}
      AND NOT EXISTS (SELECT 1 FROM workflow_design_nodes dn WHERE dn.id = d."workflowNodeId")
      AND NOT EXISTS (SELECT 1 FROM workflow_nodes rn WHERE rn.id = d."workflowNodeId")
  `
  if (Number(staleDefinitions) > 0) {
    console.log(`✓ removed ${staleDefinitions} stale WorkbenchDefinition row(s)`)
  }

  const wf = await prisma.workflow.create({
    data: {
      name: SDLC_NAME,
      description: 'Full SDLC loop (Requirements → Design → Develop → QA → Security → Release) whose stages emit the catalog artifacts (Requirements Spec, Design Doc, ADR, Test Report, Risk Assessment, Release/Rollback, Runbook).',
      status: 'PUBLISHED', teamId: TEAM_ID, capabilityId: CAPABILITY_ID, profile: 'workbench',
      workflowTypeKey: 'SDLC', typeVersion: 1,
      variables: [] as unknown as Prisma.InputJsonValue,
      eligibleWorkItemTypes: [] as unknown as Prisma.InputJsonValue,
    },
  })
  console.log(`✓ workflow ${wf.id}`)

  const workbenchConfig = {
    profile: 'blueprint', gateMode: 'manual', sourceType: 'github',
    sourceUri: '{{instance.vars.repoUrl}}', sourceRef: '', goal: '{{instance.vars.story}}',
    fallbackGoal: 'Deliver the change through the full SDLC with the required artifacts.',
    capabilityId: CAPABILITY_ID,
    agentBindings: {
      productOwnerAgentTemplateId: PRODUCT_OWNER_AGENT, architectAgentTemplateId: ARCHITECT_AGENT,
      developerAgentTemplateId: DEVELOPER_AGENT, qaAgentTemplateId: QA_AGENT,
      securityAgentTemplateId: SECURITY_AGENT, devopsAgentTemplateId: DEVOPS_AGENT,
    },
    loopDefinition: {
      version: 1, name: SDLC_NAME, maxLoopsPerStage: 3, maxTotalSendBacks: 8,
      stages: SDLC_STAGES.map((stage, idx) => ({
        key: stage.key, label: stage.label, agentRole: stage.agentRole, agentTemplateId: stage.agentTemplateId,
        next: idx < SDLC_STAGES.length - 1 ? SDLC_STAGES[idx + 1]!.key : undefined,
        terminal: stage.terminal, required: true, approvalRequired: stage.approvalRequired,
        allowedSendBackTo: stage.sendBackTo, toolPolicy: stage.toolPolicy, contextPolicy: stage.contextPolicy, repoAccess: stage.repoAccess,
        ...(stage.limits ? { limits: stage.limits } : {}),
        // templateId rides the JSON loopDefinition → normalizeExpectedArtifacts →
        // renderExpectedArtifacts injects the catalog section skeleton (M102).
        expectedArtifacts: stage.expectedArtifacts.map(a => ({ kind: a.kind, title: a.title, required: a.required, format: a.format, templateId: a.templateId })),
      })),
    },
    outputs: { finalPackKey: 'finalSdlcPack' },
  }

  const workbenchNode = await prisma.workflowDesignNode.create({
    data: {
      workflowId: wf.id, nodeType: 'WORKBENCH_TASK' as NodeType, label: 'SDLC Workbench',
      positionX: 320, positionY: 220, executionLocation: 'SERVER',
      config: { assignmentMode: 'TEAM_QUEUE', workbench: workbenchConfig } as Prisma.InputJsonValue,
    },
  })
  console.log('  + WORKBENCH_TASK node (6-stage SDLC loop)')

  // First-class WorkbenchDefinition + stage rows so the designer canvas renders.
  // Use the same promotion path as the API/runtime so the definition is keyed by
  // the actual WORKBENCH_TASK node id, not the owning workflow id.
  const promoted = await promoteWorkbenchToTables(prisma, workbenchNode.id, { workbench: workbenchConfig })
  console.log(`  + WorkbenchDefinition + ${promoted.stageCount} stage rows`)
  console.log(`\n✓ "${SDLC_NAME}" seeded. Each stage emits its catalog artifact(s); templateId drives section structure.`)
}

main().catch(err => { console.error(err); process.exit(1) }).finally(async () => { await prisma.$disconnect() })
