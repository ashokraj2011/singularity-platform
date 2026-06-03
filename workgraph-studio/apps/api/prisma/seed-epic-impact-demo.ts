/**
 * Epic → child-capability impact-analysis demo seed (M101).
 *
 * Seeds the data + templates that turn the merged reactive ENGINE (PR #72:
 * impact verdict, IAM child discovery, verdict aggregation, reactive targets,
 * workItemTypeKey passthrough, hasImpact flag) into a runnable end-to-end loop:
 *
 *   Epic parent workflow (runs for the Epic capability):
 *     START → "split" (SET_CONTEXT, demo) → WORK_ITEM #1 (IMPACT_ANALYSIS,
 *     discoverChildren) ──parks──▶ [human approves the impact rollup]
 *     → DECISION_GATE (impactWorkItem.hasImpact?) → WORK_ITEM #2 (STORY_IMPL,
 *     targetsPath=impactWorkItem.impactedChildren) ──parks──▶ [human approves]
 *     → "rollup" (SET_CONTEXT) → END
 *
 *   Child impact-analysis workflow (auto-started per discovered child):
 *     START → "assess" (SET_CONTEXT — demo hardcodes impactVerdict.impacted=true)
 *     → END   (buildChildOutput carries the verdict back to the parent)
 *
 *   Child implementation workflow (auto-started per IMPACTED child):
 *     START → "implement" (SET_CONTEXT demo placeholder; swap for WORKBENCH_TASK
 *     for real code work) → END
 *
 * Routing policies (per child capability) select each child's workflow by
 * (capabilityId + workItemTypeKey). They require the child capability IDs —
 * pass them via env so this works against any deployment:
 *
 *   EPIC_CAPABILITY_ID=<epic cap uuid> \
 *   EPIC_CHILD_CAPABILITY_IDS=<childA>,<childB> \
 *     npx ts-node prisma/seed-epic-impact-demo.ts
 *
 * IMPORTANT — the Epic discovers its children from IAM's capability-relationship
 * graph. For each child, create an IAM relationship (source=Epic, type matches
 * the convention below) BEFORE running the Epic, e.g.:
 *   POST {IAM}/capabilities/{EPIC_CAPABILITY_ID}/relationships
 *        { "target_capability_id": "<child>", "relationship_type": "decomposes_to" }
 *
 * Idempotent: upserts by fixed IDs and rebuilds graphs delete-then-create.
 */
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

// Convention: an Epic "decomposes_to" each child capability. The WORK_ITEM #1
// node filters IAM relationships by this type (standard.discoverChildren).
const CHILD_RELATIONSHIP_TYPE = 'decomposes_to'

const PLATFORM_TEAM_ID = '50000000-0000-0000-0000-000000000001'
const EPIC_WORKFLOW_ID = '30000000-0000-0000-0000-0000000ec100'
const CHILD_IMPACT_WORKFLOW_ID = '30000000-0000-0000-0000-0000000ec101'
const CHILD_IMPL_WORKFLOW_ID = '30000000-0000-0000-0000-0000000ec102'

const EPIC_CAPABILITY_ID = process.env.EPIC_CAPABILITY_ID?.trim() || null
const CHILD_CAPABILITY_IDS = (process.env.EPIC_CHILD_CAPABILITY_IDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

type NodeSpec = { key: string; nodeType: string; label: string; config?: Record<string, unknown>; x: number; y: number }
type EdgeSpec = { from: string; to: string; edgeType?: 'SEQUENTIAL' | 'CONDITIONAL'; label?: string; condition?: { field: string; op: string; value: unknown } }

async function rebuildGraph(workflowId: string, nodes: NodeSpec[], edges: EdgeSpec[]) {
  await prisma.$transaction(async tx => {
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
      const sourceNodeId = idByKey[e.from]; const targetNodeId = idByKey[e.to]
      if (!sourceNodeId || !targetNodeId) throw new Error(`Edge references unknown node: ${e.from} → ${e.to}`)
      await tx.workflowDesignEdge.create({
        data: {
          workflowId, sourceNodeId, targetNodeId,
          edgeType: (e.edgeType ?? 'SEQUENTIAL') as any,
          label: e.label,
          condition: e.condition ? (e.condition as Prisma.InputJsonValue) : undefined,
        },
      })
    }
  })
}

async function upsertWorkflow(id: string, data: { name: string; description: string; teamId: string; workflowTypeKey: string; capabilityId?: string | null }) {
  const base = {
    name: data.name, description: data.description, teamId: data.teamId,
    workflowTypeKey: data.workflowTypeKey, capabilityId: data.capabilityId ?? null,
    profile: 'main', status: 'PUBLISHED',
  }
  await prisma.workflow.upsert({ where: { id }, update: base, create: { id, ...base } })
}

async function seedWorkItemTypes() {
  const types = [
    {
      id: 'meta-workitem-epic-v1', key: 'EPIC', label: 'Epic',
      description: 'Top-level epic that fans impact analysis + implementation out to child capabilities.',
      icon: 'Layers', color: '#8b5cf6', category: 'Delivery',
      defaults: { urgency: 'NORMAL', priority: 70, routingMode: 'AUTO_START' },
      policy: { allowedRoutingModes: ['MANUAL', 'AUTO_START'] },
    },
    {
      id: 'meta-workitem-impact-analysis-v1', key: 'IMPACT_ANALYSIS', label: 'Impact Analysis',
      description: 'Analyze whether an Epic-level change impacts a child capability.',
      icon: 'Zap', color: '#f59e0b', category: 'Analysis',
      defaults: { urgency: 'NORMAL', priority: 60, routingMode: 'AUTO_START' },
      policy: { allowedRoutingModes: ['MANUAL', 'AUTO_ATTACH', 'AUTO_START'] },
    },
    {
      id: 'meta-workitem-story-impl-v1', key: 'STORY_IMPL', label: 'Story Implementation',
      description: 'Implement a story-level change in an impacted child capability.',
      icon: 'Code', color: '#10b981', category: 'Engineering',
      defaults: { urgency: 'NORMAL', priority: 50, routingMode: 'AUTO_START' },
      policy: { compatibleWorkflowTypes: ['STORY_IMPL', 'SDLC', 'GENERAL'], allowedRoutingModes: ['MANUAL', 'AUTO_ATTACH', 'AUTO_START'] },
    },
  ]
  for (const t of types) {
    const data = {
      kind: 'WORK_ITEM_TYPE' as any, key: t.key, version: 1, status: 'ACTIVE' as any,
      scopeType: 'GLOBAL' as any, scopeId: '*', label: t.label, description: t.description,
      icon: t.icon, color: t.color, category: t.category,
      defaults: t.defaults as Prisma.InputJsonValue, policy: t.policy as Prisma.InputJsonValue,
    }
    await prisma.metadataDefinition.upsert({ where: { id: t.id }, update: data, create: { id: t.id, ...data } })
    console.log(`  ✓ work-item type ${t.key}`)
  }
}

async function seedRoutingPolicies() {
  // Entry point: a top-level EPIC WorkItem targeting the Epic capability is
  // routed (AUTO_START) to the Epic template, which then does the fan-out.
  if (EPIC_CAPABILITY_ID) {
    const existing = await prisma.workItemRoutingPolicy.findFirst({ where: { capabilityId: EPIC_CAPABILITY_ID, workItemTypeKey: 'EPIC' } })
    const data = { capabilityId: EPIC_CAPABILITY_ID, workItemTypeKey: 'EPIC', workflowTypeKey: 'EPIC', workflowId: EPIC_WORKFLOW_ID, routingMode: 'AUTO_START' as any, priority: 100, isActive: true }
    if (existing) await prisma.workItemRoutingPolicy.update({ where: { id: existing.id }, data })
    else await prisma.workItemRoutingPolicy.create({ data })
    console.log(`  ✓ routing policy ${EPIC_CAPABILITY_ID} · EPIC → Epic template`)
  }
  if (CHILD_CAPABILITY_IDS.length === 0) {
    console.log('  ! EPIC_CHILD_CAPABILITY_IDS not set — skipping routing policies. Set it + re-run to make AUTO_START children resolve their workflows.')
    return
  }
  for (const capabilityId of CHILD_CAPABILITY_IDS) {
    for (const [workItemTypeKey, workflowId] of [
      ['IMPACT_ANALYSIS', CHILD_IMPACT_WORKFLOW_ID],
      ['STORY_IMPL', CHILD_IMPL_WORKFLOW_ID],
    ] as const) {
      const existing = await prisma.workItemRoutingPolicy.findFirst({ where: { capabilityId, workItemTypeKey } })
      const data = { capabilityId, workItemTypeKey, workflowTypeKey: workItemTypeKey, workflowId, routingMode: 'AUTO_START' as any, priority: 100, isActive: true }
      if (existing) await prisma.workItemRoutingPolicy.update({ where: { id: existing.id }, data })
      else await prisma.workItemRoutingPolicy.create({ data })
      console.log(`  ✓ routing policy ${capabilityId} · ${workItemTypeKey}`)
    }
  }
}

async function main() {
  console.log('Seeding Epic → child impact-analysis demo (M101)…')
  const team = (await prisma.team.findUnique({ where: { id: PLATFORM_TEAM_ID } })) ?? (await prisma.team.findFirst())
  if (!team) throw new Error('No team found. Run the base seed (npm run prisma:seed) first.')

  await seedWorkItemTypes()

  // ── Epic parent template ──────────────────────────────────────────────────
  await upsertWorkflow(EPIC_WORKFLOW_ID, {
    name: 'Epic impact dispatch',
    description: 'Discover child capabilities, dispatch impact analysis, then (human-gated) dispatch implementation to the impacted children.',
    teamId: team.id, workflowTypeKey: 'EPIC', capabilityId: EPIC_CAPABILITY_ID,
  })
  await rebuildGraph(EPIC_WORKFLOW_ID,
    [
      { key: 'start', nodeType: 'START', label: 'Start', x: 80, y: 240 },
      { key: 'split', nodeType: 'SET_CONTEXT', label: 'Split epic into stories (demo)', x: 320, y: 240,
        config: { assignments: [
          { path: 'epicTitle', value: '{{vars.epicTitle}}' },
          { path: 'storyTitle', value: '{{vars.storyTitle}}' },
        ] } },
      { key: 'impact', nodeType: 'WORK_ITEM', label: 'Impact analysis → child capabilities', x: 560, y: 240,
        config: { standard: {
          title: 'Impact analysis: {{context.epicTitle}}',
          workItemTypeKey: 'IMPACT_ANALYSIS',
          discoverChildren: { relationshipType: CHILD_RELATIONSHIP_TYPE },
          outputPath: 'impactWorkItem',
        } } },
      { key: 'gate', nodeType: 'DECISION_GATE', label: 'Any impacted children?', x: 800, y: 240 },
      { key: 'impl', nodeType: 'WORK_ITEM', label: 'Implement story → impacted children', x: 1040, y: 160,
        config: { standard: {
          title: 'Implement: {{context.storyTitle}}',
          workItemTypeKey: 'STORY_IMPL',
          targetsPath: 'impactWorkItem.impactedChildren',
          outputPath: 'implWorkItem',
        } } },
      { key: 'rollup', nodeType: 'SET_CONTEXT', label: 'Roll up child artifacts', x: 1280, y: 160,
        config: { assignments: [{ path: 'epicComplete', value: 'true' }] } },
      { key: 'end', nodeType: 'END', label: 'Epic complete', x: 1520, y: 240 },
    ],
    [
      { from: 'start', to: 'split' },
      { from: 'split', to: 'impact' },
      { from: 'impact', to: 'gate' },
      { from: 'gate', to: 'impl', edgeType: 'CONDITIONAL', label: 'Impacted', condition: { field: 'impactWorkItem.hasImpact', op: '==', value: true } },
      { from: 'gate', to: 'end', edgeType: 'CONDITIONAL', label: 'No impact', condition: { field: 'impactWorkItem.hasImpact', op: '==', value: false } },
      { from: 'impl', to: 'rollup' },
      { from: 'rollup', to: 'end' },
    ],
  )
  console.log(`  ✓ Epic template (${EPIC_WORKFLOW_ID})`)

  // ── Child impact-analysis template ────────────────────────────────────────
  await upsertWorkflow(CHILD_IMPACT_WORKFLOW_ID, {
    name: 'Child impact analysis',
    description: 'Assess whether this capability is impacted; report the verdict to the parent Epic.',
    teamId: team.id, workflowTypeKey: 'IMPACT_ANALYSIS',
  })
  await rebuildGraph(CHILD_IMPACT_WORKFLOW_ID,
    [
      { key: 'start', nodeType: 'START', label: 'Start', x: 80, y: 200 },
      // DEMO: hardcodes impacted=true. Swap for AGENT_TASK/POLICY_CHECK that
      // sets context.impactVerdict from real analysis.
      { key: 'assess', nodeType: 'SET_CONTEXT', label: 'Assess impact (demo: impacted)', x: 320, y: 200,
        config: { assignments: [
          { path: 'impactVerdict.impacted', value: 'true' },
          { path: 'impactVerdict.reason', value: 'Demo: capability assumed impacted by the epic change.' },
          { path: 'impactVerdict.affectedAreas', value: '["demo"]' },
        ] } },
      { key: 'end', nodeType: 'END', label: 'Reported', x: 560, y: 200 },
    ],
    [{ from: 'start', to: 'assess' }, { from: 'assess', to: 'end' }],
  )
  console.log(`  ✓ Child impact-analysis template (${CHILD_IMPACT_WORKFLOW_ID})`)

  // ── Child implementation template ─────────────────────────────────────────
  await upsertWorkflow(CHILD_IMPL_WORKFLOW_ID, {
    name: 'Child story implementation',
    description: 'Implement the assigned story in this capability. (Demo placeholder — swap "implement" for a WORKBENCH_TASK for real code work.)',
    teamId: team.id, workflowTypeKey: 'STORY_IMPL',
  })
  await rebuildGraph(CHILD_IMPL_WORKFLOW_ID,
    [
      { key: 'start', nodeType: 'START', label: 'Start', x: 80, y: 200 },
      { key: 'implement', nodeType: 'SET_CONTEXT', label: 'Implement story (demo placeholder)', x: 320, y: 200,
        config: { assignments: [{ path: 'finalSummary', value: 'Demo: story implemented in child capability.' }] } },
      { key: 'end', nodeType: 'END', label: 'Done', x: 560, y: 200 },
    ],
    [{ from: 'start', to: 'implement' }, { from: 'implement', to: 'end' }],
  )
  console.log(`  ✓ Child implementation template (${CHILD_IMPL_WORKFLOW_ID})`)

  await seedRoutingPolicies()

  console.log('\nEpic impact-analysis demo seeded.')
  if (!EPIC_CAPABILITY_ID) console.log('! EPIC_CAPABILITY_ID was not set — the Epic template has no capabilityId, so child discovery (IAM relationships) cannot resolve. Set it + re-run.')
  console.log(`Next: create IAM relationships source=${EPIC_CAPABILITY_ID ?? '<EPIC_CAPABILITY_ID>'} type='${CHILD_RELATIONSHIP_TYPE}' → each child, then start the Epic template.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
