/**
 * Recreate workflow templates under the M85 architecture.
 *
 * Creates a pair of fresh templates that demonstrate the new shape:
 *
 *   1. "Capability implementation loop"  · profile='workbench'
 *        — 4 stage design nodes: STORY_INTAKE → DESIGN → DEVELOP → QA
 *        — Each stage is an AGENT_TASK pinned to the right agent role.
 *        — Forward edges between them; the design becomes the loop.
 *        — M84 first-class WorkbenchDefinition + WorkbenchStage rows
 *          attached so the new canvas/inspector picks them up
 *          immediately.
 *
 *   2. "Capability workflow"             · profile='main'
 *        — 3 design nodes: HUMAN_TASK (triage) → CALL_WORKFLOW
 *          (pointing at the workbench template above) → HUMAN_TASK
 *          (final approval).
 *        — When the CALL_WORKFLOW node activates, it spawns a child
 *          instance of the workbench template; M85.s4's profile
 *          inheritance means the child is profile='workbench' and
 *          blueprint-workbench opens it; the main flow stays paused
 *          until the child completes.
 *
 * Re-running is idempotent — both templates are looked up by name
 * and deleted+recreated in one transaction. Safe to run repeatedly
 * during iteration.
 *
 * Run:
 *   DATABASE_URL="postgresql://workgraph:workgraph_secret@localhost:5434/workgraph" \
 *     npx tsx prisma/seed-workbench-recreate.ts
 */
import { PrismaClient, Prisma, type NodeType } from '@prisma/client'

const prisma = new PrismaClient()

// Reused from the prior workflows so the recreated pair binds to
// real agents in agent-and-tools. Override via env when needed.
const CAPABILITY_ID = process.env.SEED_CAPABILITY_ID
  ?? '1a7d3cf9-fada-41a8-8382-4122d3179ca7'
const TEAM_ID = process.env.SEED_TEAM_ID
  ?? '548af461-e7eb-449e-af0f-37760d1d0a66'
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT
  ?? '885ae4d8-7e5a-4f8c-81c1-1672889ac776'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT
  ?? '19f65cc6-f2f2-4c42-a0ac-27d180da07e9'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT
  ?? 'aaa33b61-651c-4d1b-91ad-266febccdcb6'
const QA_AGENT = process.env.SEED_QA_AGENT
  ?? 'b2e283d0-4df0-49ff-8404-3d67b09779c5'

const WORKBENCH_NAME = 'Capability implementation loop'
const MAIN_NAME = 'Capability workflow (main)'

interface StageSpec {
  key: string                    // operator-facing key (UPPER_SNAKE_CASE)
  label: string                  // human label
  agentRole: string              // role for the agent picker
  agentTemplateId: string        // pinned agent (overrides team default)
  toolPolicy: string             // NONE | READ_ONLY | MUTATION | VERIFICATION
  contextPolicy: string          // STORY_ONLY | REPO_READ_ONLY | CODE_EDIT | VERIFY_ONLY
  repoAccess: boolean
  terminal: boolean
  approvalRequired: boolean
  expectedArtifacts: Array<{ kind: string; title: string; format: string; required: boolean }>
  sendBackTo: string[]           // upstream stage keys allowed for regression
}

const WORKBENCH_STAGES: StageSpec[] = [
  {
    key: 'STORY_INTAKE',
    label: 'Story Intake',
    agentRole: 'PRODUCT_OWNER',
    agentTemplateId: PRODUCT_OWNER_AGENT,
    toolPolicy: 'NONE',
    contextPolicy: 'STORY_ONLY',
    repoAccess: false,
    terminal: false,
    approvalRequired: true,
    expectedArtifacts: [
      { kind: 'story_brief', title: 'Story brief', format: 'MARKDOWN', required: true },
      { kind: 'acceptance_contract', title: 'Acceptance contract', format: 'MARKDOWN', required: true },
    ],
    sendBackTo: [],
  },
  {
    key: 'DESIGN',
    label: 'Design',
    agentRole: 'ARCHITECT',
    agentTemplateId: ARCHITECT_AGENT,
    toolPolicy: 'READ_ONLY',
    contextPolicy: 'REPO_READ_ONLY',
    repoAccess: true,
    terminal: false,
    approvalRequired: true,
    expectedArtifacts: [
      { kind: 'solution_architecture', title: 'Solution architecture', format: 'MARKDOWN', required: true },
      { kind: 'approved_spec_draft', title: 'Approved spec draft', format: 'MARKDOWN', required: true },
    ],
    sendBackTo: ['STORY_INTAKE'],
  },
  {
    key: 'DEVELOP',
    label: 'Develop',
    agentRole: 'DEVELOPER',
    agentTemplateId: DEVELOPER_AGENT,
    toolPolicy: 'MUTATION',
    contextPolicy: 'CODE_EDIT',
    repoAccess: true,
    terminal: false,
    approvalRequired: true,
    expectedArtifacts: [
      { kind: 'developer_task_pack', title: 'Developer task pack', format: 'MARKDOWN', required: true },
      { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', format: 'MARKDOWN', required: true },
    ],
    sendBackTo: ['STORY_INTAKE', 'DESIGN'],
  },
  {
    key: 'QA',
    label: 'QA',
    agentRole: 'QA',
    agentTemplateId: QA_AGENT,
    toolPolicy: 'VERIFICATION',
    contextPolicy: 'VERIFY_ONLY',
    repoAccess: true,
    terminal: true,
    approvalRequired: true,
    expectedArtifacts: [
      { kind: 'qa_task_pack', title: 'QA review pack', format: 'MARKDOWN', required: true },
      { kind: 'verification_rules', title: 'Verification rules', format: 'MARKDOWN', required: true },
      { kind: 'traceability_matrix', title: 'Traceability matrix', format: 'MARKDOWN', required: true },
    ],
    sendBackTo: ['DESIGN', 'DEVELOP'],
  },
]

async function main(): Promise<void> {
  console.log('Recreating workflow templates under M85 architecture…')
  console.log(`  capability: ${CAPABILITY_ID}`)
  console.log(`  team:       ${TEAM_ID}`)
  console.log()

  // ── 0. Wipe prior runs of this seed (lookup by name; cascade
  //      cleans design rows + workbench tables). ────────────────────
  const priorWb = await prisma.workflow.findFirst({ where: { name: WORKBENCH_NAME } })
  if (priorWb) {
    await prisma.workflow.delete({ where: { id: priorWb.id } })
    console.log(`✓ Removed prior "${WORKBENCH_NAME}" (${priorWb.id})`)
  }
  const priorMain = await prisma.workflow.findFirst({ where: { name: MAIN_NAME } })
  if (priorMain) {
    await prisma.workflow.delete({ where: { id: priorMain.id } })
    console.log(`✓ Removed prior "${MAIN_NAME}" (${priorMain.id})`)
  }

  // ── 1. Workbench template (profile='workbench') ─────────────────
  const workbench = await prisma.workflow.create({
    data: {
      name: WORKBENCH_NAME,
      description: 'Standalone agent-loop template. Spawned as a child instance ' +
        'by a CALL_WORKFLOW node in a main workflow. Opens in blueprint-workbench.',
      status: 'PUBLISHED',
      teamId: TEAM_ID,
      capabilityId: CAPABILITY_ID,
      profile: 'workbench',
      workflowTypeKey: 'GENERAL',
      typeVersion: 1,
      variables: [] as unknown as Prisma.InputJsonValue,
      eligibleWorkItemTypes: [] as unknown as Prisma.InputJsonValue,
    },
  })
  console.log(`✓ Created workbench template ${workbench.id}`)

  // ── 1a. SINGLE WORKBENCH_TASK design node holding the full loop.
  //
  // (2026-05-28) Operator decision: the agent loop should open the
  // INTERACTIVE blueprint-workbench (:5176), where all four stages
  // (Story Intake → Design → Develop → QA) run in one rich session
  // with artifacts + approval gates. The interactive workbench is
  // driven by a WORKBENCH_TASK node carrying a `config.workbench`
  // loopDefinition — NOT by AGENT_TASK nodes (those run headless via
  // context-fabric and have no workbench UI). The prior shape (4
  // AGENT_TASK stage nodes) produced a child run with nothing to
  // "open" at :5176.
  //
  // So the workbench template is now a single WORKBENCH_TASK node.
  // The run viewer's WorkbenchTaskInlinePanel renders its "Open
  // WorkbenchNeo" button → buildWorkbenchLaunchUrl deep-links to
  // :5176 with this loopDefinition. Source/goal are Mustache
  // placeholders hydrated from the spawned instance's vars at
  // activation (WorkbenchTaskExecutor).
  const workbenchConfig = {
    profile: 'blueprint',
    gateMode: 'manual',
    sourceType: 'github',
    sourceUri: '{{instance.vars.repoUrl}}',
    sourceRef: '',
    goal: '{{instance.vars.story}}',
    fallbackGoal: 'Produce an approved implementation contract pack.',
    capabilityId: CAPABILITY_ID,
    agentBindings: {
      productOwnerAgentTemplateId: PRODUCT_OWNER_AGENT,
      architectAgentTemplateId: ARCHITECT_AGENT,
      developerAgentTemplateId: DEVELOPER_AGENT,
      qaAgentTemplateId: QA_AGENT,
    },
    loopDefinition: {
      version: 1,
      name: 'Capability implementation workbench loop',
      maxLoopsPerStage: 3,
      maxTotalSendBacks: 6,
      stages: WORKBENCH_STAGES.map((stage, idx) => ({
        key: stage.key,
        label: stage.label,
        agentRole: stage.agentRole,
        agentTemplateId: stage.agentTemplateId,
        next: idx < WORKBENCH_STAGES.length - 1 ? WORKBENCH_STAGES[idx + 1]!.key : undefined,
        terminal: stage.terminal,
        required: true,
        approvalRequired: stage.approvalRequired,
        allowedSendBackTo: stage.sendBackTo,
        toolPolicy: stage.toolPolicy,
        contextPolicy: stage.contextPolicy,
        repoAccess: stage.repoAccess,
        expectedArtifacts: stage.expectedArtifacts.map(a => ({
          kind: a.kind, title: a.title, required: a.required, format: a.format,
        })),
      })),
    },
    outputs: { finalPackKey: 'finalImplementationPack' },
  }

  await prisma.workflowDesignNode.create({
    data: {
      workflowId: workbench.id,
      nodeType: 'WORKBENCH_TASK' as NodeType,
      label: 'Blueprint Workbench',
      positionX: 320,
      positionY: 220,
      executionLocation: 'SERVER',
      config: {
        assignmentMode: 'TEAM_QUEUE',
        workbench: workbenchConfig,
      } as Prisma.InputJsonValue,
    },
  })
  console.log('  + 1 WORKBENCH_TASK design node (loop: Story Intake → Design → Develop → QA)')

  // ── 1c. M84 first-class WorkbenchDefinition + Stage rows. The
  //       executor's promote-on-activate will keep this in sync at
  //       runtime, but seeding directly means the canvas renders
  //       immediately without waiting for a workflow run. ─────────
  const wbDef = await prisma.workbenchDefinition.create({
    data: {
      workflowNodeId: workbench.id, // Same id; this is the template-level
                                    // marker. Per-node WorkbenchDefinitions
                                    // attach at runtime via the executor.
      name: 'Capability implementation loop',
      version: 1,
      goal: '',
      sourceType: 'github',
      capabilityId: CAPABILITY_ID,
      architectAgentTemplateId: ARCHITECT_AGENT,
      developerAgentTemplateId: DEVELOPER_AGENT,
      qaAgentTemplateId: QA_AGENT,
      maxLoopsPerStage: 3,
      maxTotalSendBacks: 6,
      gateMode: 'manual',
    },
  })
  const stageRowByKey: Record<string, string> = {}
  for (const [idx, stage] of WORKBENCH_STAGES.entries()) {
    const row = await prisma.workbenchStage.create({
      data: {
        definitionId: wbDef.id,
        stageKey: stage.key,
        label: stage.label,
        agentRole: stage.agentRole,
        agentTemplateId: stage.agentTemplateId,
        ordinal: idx,
        required: true,
        terminal: stage.terminal,
        approvalRequired: stage.approvalRequired,
        repoAccess: stage.repoAccess,
        toolPolicy: stage.toolPolicy,
        contextPolicy: stage.contextPolicy,
      },
    })
    stageRowByKey[stage.key] = row.id
    for (const [artIdx, art] of stage.expectedArtifacts.entries()) {
      await prisma.workbenchExpectedArtifact.create({
        data: {
          stageId: row.id,
          kind: art.kind,
          title: art.title,
          format: art.format,
          required: art.required,
          ordinal: artIdx,
        },
      })
    }
  }
  // Forward edges in first-class table
  for (let i = 0; i < WORKBENCH_STAGES.length - 1; i++) {
    await prisma.workbenchStageEdge.create({
      data: {
        fromStageId: stageRowByKey[WORKBENCH_STAGES[i]!.key]!,
        toStageId: stageRowByKey[WORKBENCH_STAGES[i + 1]!.key]!,
        kind: 'FORWARD',
      },
    })
  }
  // Send-back edges
  for (const stage of WORKBENCH_STAGES) {
    for (const target of stage.sendBackTo) {
      await prisma.workbenchStageEdge.create({
        data: {
          fromStageId: stageRowByKey[stage.key]!,
          toStageId: stageRowByKey[target]!,
          kind: 'SEND_BACK',
        },
      })
    }
  }
  console.log(`  + WorkbenchDefinition + ${WORKBENCH_STAGES.length} first-class stage rows`)

  // ── 2. Main template (profile='main') with HUMAN → CALL_WORKFLOW
  //      → HUMAN. The CALL_WORKFLOW points at the workbench template
  //      above; when activated, child instance gets profile='workbench'
  //      and opens in blueprint-workbench. ─────────────────────────
  const mainWf = await prisma.workflow.create({
    data: {
      name: MAIN_NAME,
      description: 'Top-level workflow demonstrating the M85 split: human triage → ' +
        'CALL_WORKFLOW spawns a workbench-profile child run → human final approval.',
      status: 'PUBLISHED',
      teamId: TEAM_ID,
      capabilityId: CAPABILITY_ID,
      profile: 'main',
      workflowTypeKey: 'GENERAL',
      typeVersion: 1,
      variables: [] as unknown as Prisma.InputJsonValue,
      eligibleWorkItemTypes: [] as unknown as Prisma.InputJsonValue,
    },
  })
  console.log(`✓ Created main template ${mainWf.id}`)

  const triage = await prisma.workflowDesignNode.create({
    data: {
      workflowId: mainWf.id,
      nodeType: 'HUMAN_TASK' as NodeType,
      label: 'Triage',
      positionX: 100, positionY: 100,
      config: {
        standard: { taskName: 'Triage', instructions: 'Confirm scope before kicking off agent loop.' },
      } as Prisma.InputJsonValue,
    },
  })
  const callNode = await prisma.workflowDesignNode.create({
    data: {
      workflowId: mainWf.id,
      nodeType: 'CALL_WORKFLOW' as NodeType,
      label: 'Run agent loop',
      positionX: 100, positionY: 260,
      config: {
        standard: { templateId: workbench.id },
        assignments: [] as Array<{ key: string; value: string }>,
      } as Prisma.InputJsonValue,
    },
  })
  const approval = await prisma.workflowDesignNode.create({
    data: {
      workflowId: mainWf.id,
      nodeType: 'HUMAN_TASK' as NodeType,
      label: 'Final approval',
      positionX: 100, positionY: 420,
      config: {
        standard: { taskName: 'Final approval', instructions: 'Sign off on the loop output.' },
      } as Prisma.InputJsonValue,
    },
  })
  await prisma.workflowDesignEdge.create({
    data: { workflowId: mainWf.id, sourceNodeId: triage.id, targetNodeId: callNode.id, edgeType: 'SEQUENTIAL' },
  })
  await prisma.workflowDesignEdge.create({
    data: { workflowId: mainWf.id, sourceNodeId: callNode.id, targetNodeId: approval.id, edgeType: 'SEQUENTIAL' },
  })
  console.log(`  + 3 design nodes + 2 edges (HUMAN_TASK → CALL_WORKFLOW → HUMAN_TASK)`)
  console.log()
  console.log('Done.')
  console.log()
  console.log(`Open the workflow designer at http://localhost:5174 and you should see:`)
  console.log(`  • "${WORKBENCH_NAME}" under the workbench profile filter`)
  console.log(`  • "${MAIN_NAME}" under the main profile filter`)
  console.log()
  console.log(`Start a run of "${MAIN_NAME}" → when the CALL_WORKFLOW node activates,`)
  console.log(`a child workbench-profile instance spawns and opens in blueprint-workbench.`)
}

main()
  .catch(err => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
