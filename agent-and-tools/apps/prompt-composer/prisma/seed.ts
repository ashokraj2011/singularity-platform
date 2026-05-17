// Prompt Composer owns PromptProfile / PromptLayer data in
// `singularity_composer`. Agent-runtime seeds AgentTemplate rows whose
// basePromptProfileId values point at these stable UUIDs.
import { createHash } from "crypto";
import { PrismaClient } from "../generated/prisma-client";

const prisma = new PrismaClient();

const IDS = {
  layers: {
    platformConstitution: "00000000-0000-0000-0000-0000000000c1",
    outputContract: "00000000-0000-0000-0000-0000000000c2",
    role: {
      ARCHITECT: "00000000-0000-0000-0000-0000000000a1",
      DEVELOPER: "00000000-0000-0000-0000-0000000000a2",
      QA: "00000000-0000-0000-0000-0000000000a3",
      GOVERNANCE: "00000000-0000-0000-0000-0000000000a4",
      SECURITY: "00000000-0000-0000-0000-0000000000a5",
      DEVOPS: "00000000-0000-0000-0000-0000000000a6",
      PRODUCT_OWNER: "00000000-0000-0000-0000-0000000000a7",
    },
  },
  profiles: {
    ARCHITECT: "00000000-0000-0000-0000-0000000000b1",
    DEVELOPER: "00000000-0000-0000-0000-0000000000b2",
    QA: "00000000-0000-0000-0000-0000000000b3",
    GOVERNANCE: "00000000-0000-0000-0000-0000000000b4",
    SECURITY: "00000000-0000-0000-0000-0000000000b5",
    DEVOPS: "00000000-0000-0000-0000-0000000000b6",
    PRODUCT_OWNER: "00000000-0000-0000-0000-0000000000b7",
  },
  // M36.1 — Stage-bound profile UUIDs. These carry taskTemplate values and
  // are kept separate from the role-base profiles (b1-b7) so a single role
  // can be bound to multiple stage templates without overwriting each other.
  stageProfiles: {
    BLUEPRINT_ARCHITECT: "00000000-0000-0000-0000-0000000000f1",
    BLUEPRINT_DEVELOPER: "00000000-0000-0000-0000-0000000000f2",
    BLUEPRINT_QA:        "00000000-0000-0000-0000-0000000000f3",
    LOOP_DEFAULT:        "00000000-0000-0000-0000-0000000000f4",
    LOOP_DEVELOPER:      "00000000-0000-0000-0000-0000000000f5",
    LOOP_QA:             "00000000-0000-0000-0000-0000000000f6",
  },
  // M36.1 — StagePromptBinding rows. Stable UUIDs so re-seed is idempotent.
  // Convention: e1xx = blueprint.*, e2xx = loop.*
  stageBindings: {
    BLUEPRINT_ARCHITECT: "00000000-0000-0000-0000-0000000000e1",
    BLUEPRINT_DEVELOPER: "00000000-0000-0000-0000-0000000000e2",
    BLUEPRINT_QA:        "00000000-0000-0000-0000-0000000000e3",
    LOOP_DEFAULT:        "00000000-0000-0000-0000-0000000000e4",
    LOOP_DEVELOPER:      "00000000-0000-0000-0000-0000000000e5",
    LOOP_QA:             "00000000-0000-0000-0000-0000000000e6",
  },
} as const;

const platformConstitution = [
  "You are operating inside Singularity Neo, a governed agent runtime.",
  "Follow the active workflow, capability scope, prompt context, budgets, approvals, citations, and audit receipts.",
  "Do not invent source facts. Use provided evidence, capability knowledge, workflow artifacts, MCP/code tools, and explicit assumptions.",
  "For implementation work, prefer small reversible changes, preserve private code boundaries, and surface uncertainty before promotion.",
  "Major artifacts, risky tool use, file mutation, release claims, and governance-sensitive decisions require the configured human gates.",
].join("\n");

const outputContract = [
  "Return concise, reviewable work products.",
  "When the stage expects artifacts, organize the response under clear headings that can be converted into durable Workgraph consumables.",
  "Include assumptions, risks, evidence references, and next-step recommendations when relevant.",
].join("\n");

const roleContracts: Array<{
  role: keyof typeof IDS.profiles;
  name: string;
  content: string;
}> = [
  {
    role: "ARCHITECT",
    name: "Architect Role Contract",
    content: "You are an Architect Agent. Analyze design, dependencies, integration boundaries, risks, and tradeoffs. Produce implementation-ready architecture artifacts and never approve or deploy your own recommendations.",
  },
  {
    role: "DEVELOPER",
    name: "Developer Role Contract",
    content: "You are a Developer Agent. Implement changes safely, prefer small reversible edits, use local AST/code tools before full-file reads, and produce code-change evidence with test guidance.",
  },
  {
    role: "QA",
    name: "QA Role Contract",
    content: "You are a QA Agent. Validate acceptance criteria, regression risk, edge cases, traceability, and evidence quality. Produce reviewable QA proof and certification guidance.",
  },
  {
    role: "GOVERNANCE",
    name: "Governance Role Contract",
    content: "You are a Governance Agent. Verify required context, approvals, budgets, policy checks, audit receipts, and release evidence. You may block unsafe promotion.",
  },
  {
    role: "SECURITY",
    name: "Security Role Contract",
    content: "You are a Security Agent. Threat-model the change, verify authorization and data exposure risks, inspect dependency and tool risk, and produce security review evidence.",
  },
  {
    role: "DEVOPS",
    name: "DevOps Role Contract",
    content: "You are a DevOps Agent. Validate deployability, environment readiness, rollback, observability, runbook impact, and release-readiness evidence.",
  },
  {
    role: "PRODUCT_OWNER",
    name: "Product Owner Role Contract",
    content: "You are a Product Owner Agent. Clarify the story, outcomes, acceptance criteria, user impact, scope boundaries, and approval readiness before downstream work starts.",
  },
];

// ─────────────────────────────────────────────────────────────
// M36.1 — Task templates moved out of workgraph-api/blueprint.router.ts.
// These replace the hardcoded architectTask/developerTask/qaTask
// + stageSystemPrompt + loopStageTask/loopStageSystemPrompt functions.
// Edit here, re-seed, and the workbench picks up the new text on its
// next /stage-prompts/resolve call — no workgraph-api redeploy.
// ─────────────────────────────────────────────────────────────

const blueprintArchitectTask = [
  "Create a solution architecture blueprint for: {{goal}}",
  "Produce a mental model, user-visible gaps, architecture decisions, risks, and a contract-pack outline.",
  "Keep the output structured with headings that can be reviewed by a human approver.",
].join("\n");

const blueprintDeveloperTask = [
  "Create a simulated developer implementation plan for: {{goal}}",
  "Do not mutate the repository. Produce expected file changes, task breakdown, code-level approach, and handoff notes.",
  "For MCP evidence, write simulated developer code change summary to blueprint-proposed-change.md if a demo write tool is available.",
].join("\n");

const blueprintQaTask = [
  "Create QA and verification coverage for: {{goal}}",
  "Produce QA tasks, verifier rules, acceptance criteria coverage, risk checks, and a certification recommendation.",
  "Identify whether any spec gaps should send the work back to the Architect stage.",
].join("\n");

// Loop-stage task template — used by the loop runner. Reuses the
// {{capturedDecisions}} / {{sendBacks}} / {{questions}} / {{artifacts}}
// values that the caller passes in `vars`.
const loopDefaultTask = [
  "Run Blueprint loop stage: {{stageLabel}}",
  "",
  "Goal: {{goal}}",
  "Stage key: {{stageKey}}",
  "Agent role: {{agentRole}}",
  "",
  "Stage description:",
  "{{stageDescription}}",
  "",
  "Expected artifacts:",
  "{{artifacts}}",
  "",
  "Configured questions:",
  "{{questions}}",
  "",
  "Latest accepted stage decisions:",
  "{{latestAccepted}}",
  "",
  "Captured stakeholder decisions and clarifications:",
  "{{capturedDecisions}}",
  "",
  "Recent feedback loops:",
  "{{sendBacks}}",
  "",
  "Do not ask an open question if the captured stakeholder decisions already answer the same intent. Reuse those answers as constraints for this stage.",
  "",
  "Return concise, structured workbench output with: decisions, risks, artifact updates for every expected artifact, only genuinely new open questions, and a gate recommendation of PASS, NEEDS_REWORK, or BLOCKED.",
].join("\n");

// Developer-specific extension to the loop task. Encodes the "you must
// actually mutate files" execution contract that was hardcoded in
// blueprint.router.ts:2335-2343.
const loopDeveloperTask = [
  loopDefaultTask,
  "",
  "Developer execution contract:",
  "- Treat captured stakeholder decisions and prior approved artifacts as implementation requirements.",
  "- Produce an actual MCP/git code change when a writable workspace is available; do not stop at design or planning text.",
  "- Inspect with AST/search/read tools, then mutate files with write_file/apply_patch and finish with git_commit or finish_work_branch so Code Review receives a captured diff.",
  "- If the requested behavior already exists, add or update tests/docs that prove it and commit those changes.",
  "- Only ask new open questions when the captured decisions are insufficient to safely implement.",
].join("\n");

// QA/test/verify-specific extension to the loop task — preserves the focus
// guidance previously in loopStageSystemPrompt's ternary branch.
const loopQaTask = [
  loopDefaultTask,
  "",
  "QA / verification focus:",
  "- Focus on verification, regressions, acceptance criteria, and certification proof.",
  "- Cite evidence references for every certification claim.",
].join("\n");

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function upsertBinding(input: {
  id: string;
  stageKey: string;
  agentRole: string | null;
  promptProfileId: string;
  description?: string;
}) {
  await prisma.stagePromptBinding.upsert({
    where: { id: input.id },
    update: {
      stageKey: input.stageKey,
      agentRole: input.agentRole,
      promptProfileId: input.promptProfileId,
      isActive: true,
      description: input.description ?? null,
    },
    create: {
      id: input.id,
      stageKey: input.stageKey,
      agentRole: input.agentRole,
      promptProfileId: input.promptProfileId,
      isActive: true,
      description: input.description ?? null,
    },
  });
}

async function upsertStageProfile(input: {
  id: string;
  name: string;
  description: string;
  stageKey: string;
  roleGate: string | null;
  taskTemplate: string;
  // Layers to link: at minimum the platform constitution + output contract.
  // Optionally a role-specific AGENT_ROLE layer.
  roleLayerId?: string;
}) {
  await prisma.promptProfile.upsert({
    where: { id: input.id },
    update: {
      name: input.name,
      description: input.description,
      ownerScopeType: "PLATFORM",
      ownerScopeId: null,
      status: "ACTIVE",
      stageKey: input.stageKey,
      roleGate: input.roleGate,
      taskTemplate: input.taskTemplate,
    },
    create: {
      id: input.id,
      name: input.name,
      description: input.description,
      ownerScopeType: "PLATFORM",
      ownerScopeId: null,
      status: "ACTIVE",
      stageKey: input.stageKey,
      roleGate: input.roleGate,
      taskTemplate: input.taskTemplate,
    },
  });
  await linkLayer(input.id, IDS.layers.platformConstitution, 10);
  if (input.roleLayerId) {
    await linkLayer(input.id, input.roleLayerId, 100);
  }
  await linkLayer(input.id, IDS.layers.outputContract, 900);
}

async function upsertLayer(input: {
  id: string;
  name: string;
  layerType: string;
  content: string;
  priority: number;
  isRequired: boolean;
}) {
  await prisma.promptLayer.upsert({
    where: { id: input.id },
    update: {
      name: input.name,
      layerType: input.layerType as never,
      scopeType: "PLATFORM",
      scopeId: null,
      content: input.content,
      priority: input.priority,
      isRequired: input.isRequired,
      status: "ACTIVE",
      contentHash: sha256(input.content),
    },
    create: {
      id: input.id,
      name: input.name,
      layerType: input.layerType as never,
      scopeType: "PLATFORM",
      scopeId: null,
      content: input.content,
      priority: input.priority,
      isRequired: input.isRequired,
      status: "ACTIVE",
      contentHash: sha256(input.content),
    },
  });
}

async function linkLayer(profileId: string, layerId: string, priority: number) {
  await prisma.promptProfileLayer.upsert({
    where: { promptProfileId_promptLayerId: { promptProfileId: profileId, promptLayerId: layerId } },
    update: { priority, isEnabled: true },
    create: { promptProfileId: profileId, promptLayerId: layerId, priority, isEnabled: true },
  });
}

async function main() {
  console.log("[prompt-composer seed] starting");

  await upsertLayer({
    id: IDS.layers.platformConstitution,
    name: "Singularity Platform Constitution",
    layerType: "PLATFORM_CONSTITUTION",
    content: platformConstitution,
    priority: 10,
    isRequired: true,
  });
  await upsertLayer({
    id: IDS.layers.outputContract,
    name: "Default Artifact Output Contract",
    layerType: "OUTPUT_CONTRACT",
    content: outputContract,
    priority: 900,
    isRequired: false,
  });

  for (const rc of roleContracts) {
    const profileId = IDS.profiles[rc.role];
    const roleLayerId = IDS.layers.role[rc.role];
    await prisma.promptProfile.upsert({
      where: { id: profileId },
      update: {
        name: `${titleRole(rc.role)} Base Profile`,
        description: `Common governed prompt profile for ${titleRole(rc.role)} agents.`,
        ownerScopeType: "PLATFORM",
        ownerScopeId: null,
        status: "ACTIVE",
      },
      create: {
        id: profileId,
        name: `${titleRole(rc.role)} Base Profile`,
        description: `Common governed prompt profile for ${titleRole(rc.role)} agents.`,
        ownerScopeType: "PLATFORM",
        ownerScopeId: null,
        status: "ACTIVE",
      },
    });
    await upsertLayer({
      id: roleLayerId,
      name: rc.name,
      layerType: "AGENT_ROLE",
      content: rc.content,
      priority: 100,
      isRequired: true,
    });
    await linkLayer(profileId, IDS.layers.platformConstitution, 10);
    await linkLayer(profileId, roleLayerId, 100);
    await linkLayer(profileId, IDS.layers.outputContract, 900);
  }

  // ─────────────────────────────────────────────────────────────
  // M36.1 — Stage-bound profiles + StagePromptBinding rows.
  // These move the prompt text out of workgraph-api/blueprint.router.ts.
  // After seeding, the workbench resolves stage prompts at runtime via
  // POST /api/v1/stage-prompts/resolve — no inline TS strings.
  // ─────────────────────────────────────────────────────────────

  await upsertStageProfile({
    id: IDS.stageProfiles.BLUEPRINT_ARCHITECT,
    name: "Blueprint Architect Stage Profile",
    description: "Drives the Architect stage of the Blueprint Workbench (3-stage architect/dev/qa run).",
    stageKey: "blueprint.architect",
    roleGate: "ARCHITECT",
    taskTemplate: blueprintArchitectTask,
    roleLayerId: IDS.layers.role.ARCHITECT,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.BLUEPRINT_DEVELOPER,
    name: "Blueprint Developer Stage Profile",
    description: "Drives the Developer stage of the Blueprint Workbench. Simulated implementation only.",
    stageKey: "blueprint.developer",
    roleGate: "DEVELOPER",
    taskTemplate: blueprintDeveloperTask,
    roleLayerId: IDS.layers.role.DEVELOPER,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.BLUEPRINT_QA,
    name: "Blueprint QA Stage Profile",
    description: "Drives the QA stage of the Blueprint Workbench.",
    stageKey: "blueprint.qa",
    roleGate: "QA",
    taskTemplate: blueprintQaTask,
    roleLayerId: IDS.layers.role.QA,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.LOOP_DEFAULT,
    name: "Blueprint Loop Default Stage Profile",
    description: "Default per-stage prompt for the Blueprint Loop runner when no role-specific binding matches.",
    stageKey: "loop.stage",
    roleGate: null,
    taskTemplate: loopDefaultTask,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.LOOP_DEVELOPER,
    name: "Blueprint Loop Developer Stage Profile",
    description: "Developer-role override for the Blueprint Loop runner. Encodes the actual-code-change execution contract.",
    stageKey: "loop.stage",
    roleGate: "DEVELOPER",
    taskTemplate: loopDeveloperTask,
    roleLayerId: IDS.layers.role.DEVELOPER,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.LOOP_QA,
    name: "Blueprint Loop QA Stage Profile",
    description: "QA/test/verify-role override for the Blueprint Loop runner.",
    stageKey: "loop.stage",
    roleGate: "QA",
    taskTemplate: loopQaTask,
    roleLayerId: IDS.layers.role.QA,
  });

  // Bindings: (stageKey, agentRole?) → stageProfile.id
  await upsertBinding({
    id: IDS.stageBindings.BLUEPRINT_ARCHITECT,
    stageKey: "blueprint.architect",
    agentRole: null,
    promptProfileId: IDS.stageProfiles.BLUEPRINT_ARCHITECT,
    description: "Blueprint Architect stage — single binding (role implied by stage).",
  });
  await upsertBinding({
    id: IDS.stageBindings.BLUEPRINT_DEVELOPER,
    stageKey: "blueprint.developer",
    agentRole: null,
    promptProfileId: IDS.stageProfiles.BLUEPRINT_DEVELOPER,
    description: "Blueprint Developer stage.",
  });
  await upsertBinding({
    id: IDS.stageBindings.BLUEPRINT_QA,
    stageKey: "blueprint.qa",
    agentRole: null,
    promptProfileId: IDS.stageProfiles.BLUEPRINT_QA,
    description: "Blueprint QA stage.",
  });
  await upsertBinding({
    id: IDS.stageBindings.LOOP_DEFAULT,
    stageKey: "loop.stage",
    agentRole: null,
    promptProfileId: IDS.stageProfiles.LOOP_DEFAULT,
    description: "Loop stage default — fallback when no role-specific binding matches.",
  });
  await upsertBinding({
    id: IDS.stageBindings.LOOP_DEVELOPER,
    stageKey: "loop.stage",
    agentRole: "DEVELOPER",
    promptProfileId: IDS.stageProfiles.LOOP_DEVELOPER,
    description: "Loop stage — DEVELOPER role override (must mutate files).",
  });
  await upsertBinding({
    id: IDS.stageBindings.LOOP_QA,
    stageKey: "loop.stage",
    agentRole: "QA",
    promptProfileId: IDS.stageProfiles.LOOP_QA,
    description: "Loop stage — QA/test/verify role override.",
  });

  console.log("[prompt-composer seed] done");
}

function titleRole(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

main()
  .catch((err) => {
    console.error("[prompt-composer seed] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
