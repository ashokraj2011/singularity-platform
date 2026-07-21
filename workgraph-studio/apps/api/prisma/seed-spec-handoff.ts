/**
 * Spec Handoff (Off-Platform Development) — the "design here, build there, check it
 * came back right" flow.
 *
 * Sibling of seed-sdlc-copilot.ts (every phase runs SERVER-side) and
 * seed-sdlc-copilot-external.ts (every phase runs off-platform). This template is the
 * HYBRID neither of those expresses:
 *
 *   1. Requirements + Design run ON-PLATFORM as governed AGENT_TASK phases
 *      (useGovernedExecutor → the governance overlay + audit trail). No
 *      executor:'copilot', so they run through agent-runtime, not a laptop.
 *   2. A human freezes a SpecificationVersion and publishes the developer handoff.
 *   3. The run PARKS on a SIGNAL_WAIT barrier while a developer builds the change
 *      OFF-PLATFORM with their own agent, from the exported Copilot workflow YAML.
 *   4. A human then triggers a manual-start RECONCILE node, which measures what came
 *      back against the frozen specification, requirement by requirement.
 *
 * Topology:
 *   START → CREATE_BRANCH
 *         → AGENT_TASK Requirements (governed, on-platform)
 *         → AGENT_TASK Design (governed, on-platform)
 *         → HUMAN_TASK Freeze specification
 *         → HUMAN_TASK Developer handoff
 *         → SIGNAL_WAIT Await off-platform implementation    ← the pause
 *         → RECONCILE Reconcile change against specification ← startMode:'manual'
 *         → APPROVAL Accept reconciliation verdict
 *         → END
 *
 * ── How the pause works ──────────────────────────────────────────────────────
 * The SIGNAL_WAIT barrier parks the run (node stays ACTIVE; StuckRunSweep exempts
 * SIGNAL_WAIT, so it is never force-failed). It carries `executor:'copilot'` + a
 * `task`, which is what makes `copilotStagesFromNodes` include it as an export stage
 * — so the exported YAML shows the developer the prompt, the document contract, AND
 * a `stages[].signalName`. The runner's `post_signal()` then POSTs
 * `/api/workgraph/workflow-instances/:id/signals/handoff.IMPLEMENTATION` to release
 * it. `signalName` is set BOTH top-level and under `standard` because the three
 * receivers disagree about where they read it (SignalEmitExecutor reads only
 * `standard.signalName`).
 *
 * The export already carries the repo world model (composed into each stage prompt)
 * and a `specification:` block (versionId, contentHash, in-scope requirements,
 * acceptance criteria, test obligations, reconciliation policy). Neither is created
 * by this seed — both are existing export behaviour. Where no world model exists the
 * export degrades with a warning, which is correct.
 *
 * ── How the human-invoked reconciliation works ───────────────────────────────
 * `startMode:'manual'` leaves the node ACTIVE with `config._awaitingStart=true`; a
 * human triggers it with POST /workflow-instances/:id/nodes/:nodeId/start. That is a
 * real, verified gate, and `startAwaitingNode` passes the triggering user's id through
 * as the actor — so the reconciliation run is attributed to the person who asked for it.
 *
 * The RECONCILE node then calls `startReconciliation` — the SAME service
 * ReconciliationStudio and the copilot results post-back use — against the frozen
 * SpecificationVersion, producing the per-requirement verdict matrix inside the run.
 * The workflow now PERFORMS the reconciliation; it no longer merely gates on one
 * somebody ran elsewhere. (Earlier revisions of this template approximated it with a
 * VERIFIER node, which validates DOCUMENTS against criteria — a different, weaker check.)
 *
 * The two pre-existing routes still work and are unchanged: the developer's runner
 * POSTing to /export/copilot-results (reconcileCopilotResults → startReconciliation),
 * and POST /api/work-items/:id/submissions/:sid/reconcile by hand. The node reconciles
 * the most recent non-REJECTED submission, so it reads whatever those produced.
 *
 * What advances and what halts is deliberate and is NOT symmetric:
 *   • VERIFIED_PASS / PASSED           → advance (an executed, fully passing test plan)
 *   • DECLARED_CONSISTENT /            → advance, labelled DECLARED — the claims line up
 *     SEMANTICALLY_REVIEWED              but nothing ran. The Work Item does NOT become
 *                                        VERIFIED; only VERIFIED_PASS does that
 *                                        (applyReconciliationCompletionGate).
 *   • NOT_VERIFIED                     → HALT. The run measured nothing. This is not a
 *                                        failure and is recorded under its own mutation
 *                                        type + audit event so it can never be skimmed as
 *                                        one, and never advances as if verified.
 *   • FAILED / PARTIAL / ERROR         → HALT. Measured, and found wanting.
 *   • RUNNING (DYNAMIC)                → HALT as AWAITING_TESTS until the runner reports.
 * The trailing APPROVAL node is where a human signs off on the verdict.
 *
 * NOT auto-routed — seeds no workItemRoutingPolicy, so it never supersedes the
 * in-platform SDLC route. A PUBLISHED, COMMON template picked explicitly in guided
 * launch.
 *
 * Idempotent — fixed ids, upserted. Run (after the role agent templates exist):
 *   SEED_CAPABILITY_ID=… SEED_TEAM_ID=… npx tsx prisma/seed-spec-handoff.ts
 */
import { PrismaClient, type NodeType } from '@prisma/client'

const prisma = new PrismaClient()

const TEAM_ID = process.env.SEED_TEAM_ID ?? '50000000-0000-0000-0000-000000000001'
// Role agent templates — the REAL AgentTemplate ids agent-runtime/prisma/seed.ts
// creates (00000000-…d1..d8), so the governed phases bind to existing agents and the
// export's per-stage prompt names the role.
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT ?? '00000000-0000-0000-0000-0000000000d7'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT ?? '00000000-0000-0000-0000-0000000000d1'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT ?? '00000000-0000-0000-0000-0000000000d2'
// Governance posture for the two on-platform phases. fail_closed = audit-governance
// must be reachable; fail_open attempts governance but proceeds if it is briefly down.
const GOVERNANCE_MODE = process.env.SEED_GOVERNANCE_MODE ?? 'fail_closed'
// Optional repo fallback (capability-INDEPENDENT: each phase resolves the WORK ITEM's
// capability + repo at runtime; sourceUri is only a last-resort fallback).
const DEFAULT_REPO = process.env.SEED_COPILOT_REPO_URL

const WF_NAME = 'Spec Handoff (Off-Platform Development)'
const WF_ID = '3bf00000-0000-0000-0000-0000000000f0'
const PHASE_ID = '3bf10000-0000-0000-0000-0000000000f0'
// Distinct id families from seed-sdlc-copilot.ts (3b2000…) and
// seed-sdlc-copilot-external.ts (3be2…) so all three coexist.
const hx = (n: number) => n.toString(16).padStart(2, '0')
const nid = (n: number) => `3bf20000-0000-0000-0000-0000000000${hx(n)}` // nodes
const eid = (n: number) => `3bf30000-0000-0000-0000-0000000000${hx(n)}` // edges

// The signal that releases the off-platform barrier. The exported runner appends this
// to platform.signalEndpoint; a human can also POST it directly to un-park the run.
const HANDOFF_SIGNAL = 'handoff.IMPLEMENTATION'

type Json = Record<string, unknown>

// ── Artifact IN/OUT contract (same shape as the sibling SDLC seeds) ──────────
interface ArtifactSpec { type: string; name: string }
const A = {
  requirements:   { type: 'requirements',    name: 'Requirements & Acceptance' },
  design:         { type: 'design',          name: 'Design Document' },
  implementation: { type: 'implementation',  name: 'Implementation' },
  testReport:     { type: 'test-report',     name: 'Test Report' },
} as const

const A_META: Record<string, { folder: string; file: string; template: string }> = {
  'requirements':   { folder: 'product-owner', file: 'REQUIREMENTS.md',   template: '# Requirements & Acceptance\n\n## Summary\n\n## Functional requirements\n- \n\n## Acceptance criteria\n- \n\n## Edge cases\n- \n\n## Out of scope\n- ' },
  'design':         { folder: 'architect',     file: 'DESIGN.md',         template: '# Design Document\n\n## Overview\n\n## Components\n\n## Data flow\n\n## Interfaces & contracts\n\n## Risks & trade-offs\n\n## Alternatives considered' },
  'implementation': { folder: 'developer',     file: 'IMPLEMENTATION.md', template: '# Implementation Summary\n\n## What changed\n\n## Why\n\n## Files touched\n- \n\n## Tests added\n- \n\n## How to verify' },
  'test-report':    { folder: 'qa',            file: 'TEST_REPORT.md',    template: '# Test Report\n\n## Scope\n\n## Results\n\n## Coverage\n\n## Defects & follow-ups\n- ' },
}

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
      // executionLocation MUST stay SERVER. On the mid-run advance path the
      // executionLocation gate runs BEFORE gateNodeStart, so a non-SERVER node
      // queues to pending_executions and its startMode is silently ignored — the
      // manual-start RECONCILE below would never gate.
      label: n.label, config, executionLocation: 'SERVER', positionX: n.x, positionY: 200,
    },
  })
}

async function upsertEdge(e: { id: string; from: string; to: string }) {
  await (prisma as any).workflowDesignEdge.upsert({
    where: { id: e.id },
    // Re-point endpoints on re-seed too — positional edge ids shift if a node is
    // inserted into `order`, and an update that only touched edgeType would leave
    // existing edges pointing at their OLD nodes.
    update: { edgeType: 'SEQUENTIAL', sourceNodeId: e.from, targetNodeId: e.to },
    create: { id: e.id, workflowId: WF_ID, sourceNodeId: e.from, targetNodeId: e.to, edgeType: 'SEQUENTIAL' },
  })
}

async function main(): Promise<void> {
  console.log(`Seeding "${WF_NAME}" (on-platform spec → off-platform build → human validation)…`)

  const N_START = nid(0)
  const N_CREATE_BRANCH = nid(1)
  const N_REQUIREMENTS = nid(2)
  const N_DESIGN = nid(3)
  const N_FREEZE_SPEC = nid(4)
  const N_HANDOFF = nid(5)
  const N_BARRIER = nid(6)
  const N_VALIDATE = nid(7)
  const N_ACCEPT = nid(8)
  const N_END = nid(9)
  const order = [
    N_START, N_CREATE_BRANCH, N_REQUIREMENTS, N_DESIGN, N_FREEZE_SPEC,
    N_HANDOFF, N_BARRIER, N_VALIDATE, N_ACCEPT, N_END,
  ]
  const xOf = (id: string) => 80 + order.indexOf(id) * 200

  // capabilityId: null → COMMON / platform template. Capability-INDEPENDENT: the
  // governed phases resolve the WORK ITEM's capability + repo at runtime. A pinned
  // capabilityId would make guided launch's `workflow-capability-mismatch` check
  // block this template on every other capability.
  await (prisma as any).workflow.upsert({
    where: { id: WF_ID },
    update: {
      name: WF_NAME, capabilityId: null, teamId: TEAM_ID, profile: 'main', workflowTypeKey: 'SDLC',
      metadata: { usesCopilot: true, copilotExternal: true, specHandoff: true, visibility: 'GLOBAL' },
    },
    create: {
      id: WF_ID, name: WF_NAME,
      description: 'Requirements and design run on-platform as governed phases and a human freezes a ' +
        'SpecificationVersion. The run then parks on a SIGNAL_WAIT barrier while a developer builds the ' +
        'change off-platform from the exported Copilot workflow YAML (which carries the repo world model ' +
        'and the specification). A human then triggers the validation node to check what came back.',
      status: 'PUBLISHED', currentVersion: 1, profile: 'main', workflowTypeKey: 'SDLC',
      teamId: TEAM_ID, capabilityId: null,
      metadata: { usesCopilot: true, copilotExternal: true, specHandoff: true, visibility: 'GLOBAL' },
    },
  })
  await (prisma as any).workflowVersion.upsert({
    where: { templateId_version: { templateId: WF_ID, version: 1 } },
    update: { graphSnapshot: { nodes: order.map((id) => ({ id })), edges: [] } },
    create: { templateId: WF_ID, version: 1, graphSnapshot: { nodes: order.map((id) => ({ id })), edges: [] } },
  })
  await (prisma as any).workflowDesignPhase.upsert({
    where: { id: PHASE_ID },
    update: { name: 'Spec Handoff' },
    create: { id: PHASE_ID, workflowId: WF_ID, name: 'Spec Handoff', displayOrder: 0 },
  })

  await upsertNode({ id: N_START, nodeType: 'START', label: 'Intake', x: xOf(N_START) })

  // Create the work branch (wi/<code>) up-front so the developer has a branch to
  // clone and push back to, and so the export's preflight does not warn.
  // interactive:true → the run asks the operator for the base branch before creating
  // it. No startMode:'manual' — the interactive form IS the gate.
  await upsertNode({
    id: N_CREATE_BRANCH, nodeType: 'CREATE_BRANCH', label: 'Create work branch',
    x: xOf(N_CREATE_BRANCH), config: { interactive: true },
  })

  // ── On-platform governed phases ────────────────────────────────────────────
  // No executor:'copilot' and no preferLaptop → these run through agent-runtime
  // SERVER-side, not on a laptop. useGovernedExecutor:true puts them through the
  // governed loop (governance overlay + audit). Each ends AWAITING_REVIEW, which is
  // the human gate between phases — so no startMode is needed here.
  await upsertNode({
    id: N_REQUIREMENTS, nodeType: 'AGENT_TASK', label: 'Requirements (governed)', x: xOf(N_REQUIREMENTS),
    config: {
      agentTemplateId: PRODUCT_OWNER_AGENT,
      task: 'Write a clear Requirements & Acceptance spec for this work item:\n\n{{instance.vars.story}}\n\n' +
        'List functional requirements, acceptance criteria, and edge cases. These become the requirements of ' +
        'the frozen specification the off-platform developer will build against, so make each one ' +
        'individually checkable. Save it as the file ' +
        'deliverables/{{instance.vars.workCode}}/product-owner/REQUIREMENTS.md (create the folders if needed).',
      governanceMode: GOVERNANCE_MODE, useGovernedExecutor: true,
      governedStageKey: 'REQUIREMENTS', governedAgentRole: 'PRODUCT_OWNER',
      inputArtifacts: artifactDefs(undefined, 'INPUT'),
      outputArtifacts: artifactDefs([A.requirements], 'OUTPUT'),
      ...(DEFAULT_REPO ? { sourceType: 'github', sourceUri: DEFAULT_REPO } : {}),
    },
  })
  await upsertNode({
    id: N_DESIGN, nodeType: 'AGENT_TASK', label: 'Design (governed)', x: xOf(N_DESIGN),
    config: {
      agentTemplateId: ARCHITECT_AGENT,
      task: 'Produce a Design Document (and an ADR if a significant decision is involved) for:\n\n' +
        '{{instance.vars.story}}\n\nCover components, data flow, interfaces and risks. Trace each design ' +
        'decision back to a requirement so the reconciliation can check them. Save it as the file ' +
        'deliverables/{{instance.vars.workCode}}/architect/DESIGN.md (create the folders if needed).',
      governanceMode: GOVERNANCE_MODE, useGovernedExecutor: true,
      governedStageKey: 'DESIGN', governedAgentRole: 'ARCHITECT',
      inputArtifacts: artifactDefs([A.requirements], 'INPUT'),
      outputArtifacts: artifactDefs([A.design], 'OUTPUT'),
      ...(DEFAULT_REPO ? { sourceType: 'github', sourceUri: DEFAULT_REPO } : {}),
    },
  })

  // ── Freeze the specification ───────────────────────────────────────────────
  // NO node type creates, approves or binds a SpecificationVersion — the whole
  // specification surface is a Work Item child API
  // (POST /api/work-items/:id/specifications/:versionId/approve). This node is the
  // GATE that holds the run until a human has done it; it does not do it.
  await upsertNode({
    id: N_FREEZE_SPEC, nodeType: 'HUMAN_TASK', label: 'Freeze specification', x: xOf(N_FREEZE_SPEC),
    config: {
      assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID, widgets: [],
      description:
        'Turn the approved requirements and design into a frozen specification, then complete this task.\n\n' +
        '1. Open this run\'s Work Item → Specification tab.\n' +
        '2. Author or generate the specification version from the two documents above.\n' +
        '3. Approve it. Approving freezes it and fixes its contentHash — that hash is what the ' +
        'reconciliation later measures the returned change against.\n\n' +
        'Until an approved specification is bound to the Work Item, the Copilot YAML export carries no ' +
        '`specification:` block and the developer\'s agent is ungrounded.',
      inputArtifacts: artifactDefs([A.requirements, A.design], 'INPUT'),
    },
  })

  // ── Developer handoff ──────────────────────────────────────────────────────
  // Publishing the handoff is also a Work Item API
  // (POST /api/work-items/:id/development-target/publish). The export itself is
  // always reachable on any instance: GET /export/copilot-yaml.
  await upsertNode({
    id: N_HANDOFF, nodeType: 'HUMAN_TASK', label: 'Developer handoff', x: xOf(N_HANDOFF),
    config: {
      assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID, widgets: [],
      description:
        'Publish the handoff and give the developer the exported workflow, then complete this task.\n\n' +
        '1. Work Item → publish the development target / handoff generation. A submission cannot be ' +
        'registered against an unpublished handoff, so skipping this means no reconciliation later.\n' +
        '2. Download the Copilot workflow YAML:\n' +
        `   GET /api/workgraph/workflow-instances/{runId}/export/copilot-yaml?fromPhase=IMPLEMENTATION\n` +
        '   fromPhase keeps the finished requirements/design phases as context and makes the ' +
        'implementation barrier the first runnable stage.\n' +
        '3. Send it to the developer with the runner script ' +
        '(GET /export/copilot-runner.sh) and a SINGULARITY_TOKEN.\n\n' +
        'The export embeds the repo world model into each stage prompt and a `specification:` block ' +
        '(versionId, contentHash, in-scope requirements, acceptance criteria, test obligations, ' +
        'reconciliation policy), so the developer\'s agent is grounded without any extra briefing. ' +
        'If the capability has no world model the export still works and says so in a warning.',
      inputArtifacts: artifactDefs([A.requirements, A.design], 'INPUT'),
    },
  })

  // ── The pause ──────────────────────────────────────────────────────────────
  // SIGNAL_WAIT parks the run (stays ACTIVE, exempt from StuckRunSweep) until
  // POST /workflow-instances/:id/signals/handoff.IMPLEMENTATION arrives — from the
  // exported runner's post_signal(), or from a human un-parking it by hand.
  // signalName is set in BOTH places on purpose: the HTTP receiver and
  // SignalWaitExecutor accept either, but SignalEmitExecutor reads only
  // standard.signalName. executor:'copilot' + task are what make
  // copilotStagesFromNodes emit this as an export stage carrying stages[].signalName.
  await upsertNode({
    id: N_BARRIER, nodeType: 'SIGNAL_WAIT', label: 'Await off-platform implementation', x: xOf(N_BARRIER),
    config: {
      signalName: HANDOFF_SIGNAL,
      standard: { signalName: HANDOFF_SIGNAL },
      executor: 'copilot',
      task: 'Implement this change end-to-end in the repository, working from the frozen specification in ' +
        'this file\'s `specification:` block:\n\n{{instance.vars.story}}\n\nBuild every in-scope requirement, ' +
        'satisfy its acceptance criteria, and add or extend tests for the new behaviour until they pass. ' +
        'Write a short Implementation summary as ' +
        'deliverables/{{instance.vars.workCode}}/developer/IMPLEMENTATION.md and a Test Report as ' +
        'deliverables/{{instance.vars.workCode}}/qa/TEST_REPORT.md (create the folders if needed). ' +
        'Commit and push to the work branch, then post your results back so the platform can reconcile ' +
        'them against the specification.',
      governedStageKey: 'IMPLEMENTATION', governedAgentRole: 'DEVELOPER', agentTemplateId: DEVELOPER_AGENT,
      inputArtifacts: artifactDefs([A.requirements, A.design], 'INPUT'),
      outputArtifacts: artifactDefs([A.implementation, A.testReport], 'OUTPUT'),
      ...(DEFAULT_REPO ? { sourceType: 'github', sourceUri: DEFAULT_REPO } : {}),
    },
  })

  // ── Human-invoked validation ───────────────────────────────────────────────
  // startMode:'manual' → the flow reaches this node, gateNodeStart marks it
  // _awaitingStart and does NOT execute it. A human triggers it with
  // POST /workflow-instances/:id/nodes/:nodeId/start (the run view's Start button),
  // and startAwaitingNode passes THAT person's id through as the actor — which is
  // what the reconciliation run is attributed to.
  //
  // This is the real reconciliation: RECONCILE calls startReconciliation against the
  // frozen SpecificationVersion and produces the per-requirement verdict matrix.
  //
  // Outcomes (see ReconcileExecutor):
  //   advance  VERIFIED  — an executed, fully passing test plan (VERIFIED_PASS/PASSED)
  //   advance  DECLARED  — claims consistent with the spec (DECLARED_CONSISTENT /
  //                        SEMANTICALLY_REVIEWED). Real but weaker: nothing executed.
  //   halt     NOT_VERIFIED — the run measured NOTHING. Not a failure.
  //   halt     FAILED       — measured and found wanting.
  //   halt     AWAITING_TESTS / HALTED
  //
  // requireChangeManifest defaults to true in the executor, so an empty diff comes back
  // NOT_VERIFIED rather than clean. Expect NOT_VERIFIED when the developer's post-back
  // declared no per-requirement claims — that is the honest answer, and the halt message
  // says exactly what to do about it.
  await upsertNode({
    id: N_VALIDATE, nodeType: 'RECONCILE', label: 'Reconcile change against specification', x: xOf(N_VALIDATE),
    config: {
      startMode: 'manual',
      mode: 'DETERMINISTIC',
      // false → a DECLARED_CONSISTENT result advances to the human sign-off below, labelled
      // as a declaration check rather than a verified pass. Set true to refuse anything
      // short of an executed, fully passing test plan (pair it with mode:'DYNAMIC').
      requireVerifiedPass: false,
      standard: { startMode: 'manual', mode: 'DETERMINISTIC' },
      inputArtifacts: artifactDefs([A.implementation, A.testReport], 'INPUT'),
    },
  })

  // ── Accept the reconciliation verdict ──────────────────────────────────────
  // The RECONCILE node above produced the verdict matrix inside the run. This node is
  // where a human reads it and signs off — the graph performs the reconciliation, a
  // person still owns accepting it.
  await upsertNode({
    id: N_ACCEPT, nodeType: 'APPROVAL', label: 'Accept reconciliation verdict', x: xOf(N_ACCEPT),
    config: {
      assignmentMode: 'TEAM_QUEUE', teamId: TEAM_ID,
      description:
        'Review the reconciliation verdict matrix before accepting the change.\n\n' +
        'The previous node ran the reconciliation against the frozen specification and recorded a ' +
        'per-requirement verdict matrix; its run id is in the run context under `reconcile`. Open the ' +
        'Work Item → Reconciliation to read the verdicts and findings, then approve or reject here.\n\n' +
        'If you are seeing this step, the reconciliation returned either VERIFIED (an executed, fully ' +
        'passing test plan) or DECLARED (the developer\'s claims are consistent with the specification, ' +
        'but nothing was executed). Check which one before approving — DECLARED does NOT make the Work ' +
        'Item verified.',
      inputArtifacts: artifactDefs([A.implementation, A.testReport], 'INPUT'),
    },
  })

  await upsertNode({ id: N_END, nodeType: 'END', label: 'Done', x: xOf(N_END) })

  for (let i = 0; i < order.length - 1; i++) {
    await upsertEdge({ id: eid(i), from: order[i]!, to: order[i + 1]! })
  }

  console.log(`✓ "${WF_NAME}" (${WF_ID})`)
  console.log('  START → CREATE_BRANCH → Requirements → Design → Freeze spec → Handoff →')
  console.log(`  SIGNAL_WAIT(${HANDOFF_SIGNAL}) → RECONCILE(manual start) → APPROVAL → END`)
  console.log('  export: GET /api/workgraph/workflow-instances/:id/export/copilot-yaml?fromPhase=IMPLEMENTATION')
  console.log(`  release the barrier: POST /api/workgraph/workflow-instances/:id/signals/${HANDOFF_SIGNAL}`)
  console.log('  then a human clicks Start on "Reconcile change against specification".')
  console.log('  NOT auto-routed — pick this template explicitly in guided launch.')
}

main()
  .then(() => console.log('✓ done'))
  .catch((e) => { console.error('ERR', e?.message ?? e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
