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
    // M36.3 — tool-policy layers (TOOL_CONTRACT). These replace mcp-server's
    // inline `invoke.ts:854-880` system-message injection. Composer attaches
    // them to the right profiles; mcp-server runs as a dumb tool runner.
    localCodeIntelligence:  "00000000-0000-0000-0000-0000000000c3",
    developerCodeMutation:  "00000000-0000-0000-0000-0000000000c4",
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

// M36.3 — tool-policy layer content. Previously hardcoded in
// mcp-server/src/mcp/invoke.ts:854-880 and conditionally injected as system
// messages. Now lives here as TOOL_CONTRACT layers that composer attaches to
// the right profiles before the assembled prompt ever reaches mcp-server.
const localCodeIntelligencePolicy = [
  "Local code intelligence policy:",
  "- For code inspection or edits, use AST tools before full-file reads.",
  "- Start with find_symbol or get_dependencies, then get_symbol for signatures and summaries.",
  "- Use get_ast_slice for exact source ranges. Use read_file only when a full file is explicitly needed.",
  "- Keep private workspace code local; report summaries, slices, changed paths, branch, commit SHA, and receipts.",
].join("\n");

const developerCodeMutationPolicy = [
  "Developer code-mutation policy:",
  "- This run is expected to produce real MCP/git code-change evidence.",
  "- Do not provide only a narrative implementation plan.",
  "- Inspect the workspace with MCP code tools, modify files with apply_patch or write_file, and finish with git_commit or finish_work_branch.",
  "- If no source change is needed, commit test or documentation evidence that proves the requested behavior.",
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

// M36.6 — extraContext templates. These replace the inline `extraContext`
// blocks in workgraph-api/blueprint.router.ts:2122-2131. Rendered with the
// same {{vars}} as taskTemplate, so {{sourceType}}/{{sourceUri}}/{{sourceRef}}
// substitute from the per-session values the caller passes.
const loopDeveloperExtraContext = [
  "Developer stage execution policy:",
  "- Prefer actual MCP local code tools over narrative-only output.",
  "- First verify the writable MCP workspace matches the requested source/repository before mutating files.",
  "- Use AST/search/read tools to locate the correct source files, then use write_file/apply_patch/git_commit/finish_work_branch to create a real captured diff.",
  "- Do not fabricate changed files or patch text. If the writable workspace is missing or does not match the source, say that no actual code change was captured.",
  "Requested source: {{sourceType}} {{sourceUri}}{{sourceRefSuffix}}",
].join("\n");

const loopDefaultExtraContext =
  "Produce governed workbench artifacts and evidence. Do not mutate source files unless this is the Developer stage with a verified writable MCP workspace.";

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

// ─────────────────────────────────────────────────────────────
// M36.4 — Single-shot SystemPrompts. Previously hardcoded in 6 services;
// now centralised so prompt engineers can edit + re-seed.
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS: Array<{
  id: string;
  key: string;
  content: string;
  description: string;
  modelHint?: string;
}> = [
  {
    id: "00000000-0000-0000-0000-000000000d01",
    key: "event-horizon.system",
    description:
      "Event Horizon assistant system prompt. Was hardcoded in workgraph-api/event-horizon.router.ts:120-130.",
    content: [
      "You are Event Horizon, the Singularity platform assistant.",
      "You understand the entire Singularity application: Operations Portal, IAM, Agent Runtime, Workflow Manager, Blueprint Workbench, Prompt Composer, Context Fabric, MCP, and Audit Governance.",
      "Answer from the current application context, then from the platform map and live summary.",
      "Be concise, practical, and governance-aware.",
      "You may recommend safe operator actions, but do not claim that a mutation was performed.",
      "Allowed action intents are explain_stuck_nodes, summarize_run, find_evidence, draft_approval_note, and recommend_budget_model.",
      "When an action intent is present, answer in that mode and cite the relevant run, budget, approval, artifact, or receipt fields from context.",
      "If a user asks where to do something, name the owning application and give the safest next screen/action.",
      "If evidence is incomplete, call that out explicitly instead of overclaiming.",
    ].join("\n"),
  },
  {
    id: "00000000-0000-0000-0000-000000000d02",
    key: "agent-service.distillation",
    description:
      "Knowledge-distillation prompt for memory candidates. Was hardcoded in agent-service/routes/runtime.ts:158-165.",
    content: [
      "You are a knowledge distillation assistant.",
      "Given multiple agent observations of the same `candidate_type`, synthesise them",
      "into 1-3 concise, generalised memory rules an agent can reuse on future tasks.",
      "Each rule must have a short `title` (<= 80 chars) and a `content` body (<= 600 chars).",
      "Return STRICT JSON: an array of {title, content, confidence} where confidence is in [0,1].",
      "Do not include any text outside the JSON array. No markdown fences.",
    ].join("\n"),
  },
  {
    id: "00000000-0000-0000-0000-000000000d03",
    key: "tool-service.summarise-text",
    description:
      "Summarise-text internal tool prompt. Mustache var: {{maxChars}}. Was hardcoded in tool-service/routes/internal-tools.ts:147.",
    content: "You write concise summaries. Reply with a single paragraph (<={{maxChars}} chars). No markdown, no preamble.",
  },
  {
    id: "00000000-0000-0000-0000-000000000d04",
    key: "tool-service.extract-entities",
    description:
      "Extract-entities internal tool prompt. Was hardcoded in tool-service/routes/internal-tools.ts:160-164.",
    content:
      "Extract named entities from the text. Return STRICT JSON: " +
      "{\"entities\":[{\"kind\":string,\"value\":string,\"confidence\":number}]}. " +
      "No commentary, no markdown. Use only the requested kinds.",
  },
  {
    id: "00000000-0000-0000-0000-000000000d05",
    key: "agent-runtime.symbol-summarise",
    description:
      "Code-symbol summary prompt for retrieval indexes. Was hardcoded in agent-runtime/lib/llm/summarise.ts:29-34.",
    content: [
      "You write concise one-line summaries of code symbols for retrieval indexes.",
      "Given a symbol declaration + surrounding code, produce ONE sentence (<=120 chars)",
      "describing what it does. No leading articles, no trailing period required.",
      "Return only the summary text — no quotes, no markdown, no explanation.",
    ].join("\n"),
  },
  {
    id: "00000000-0000-0000-0000-000000000d06",
    key: "prompt-composer.capsule-compiler",
    description:
      "Context-capsule compiler prompt. Was hardcoded in prompt-composer/modules/compose/llm-capsule-compiler.ts:22-32.",
    content: `You are a Context Compiler.

INPUT: a list of retrieval chunks. Each chunk has a 〔cite: …〕 marker
that ties it to a source artifact or distilled memory.

TASK: produce ONE paragraph (≤500 words) that compresses every factual
claim across the chunks. Preserve every 〔cite: …〕 marker that backs a
claim you keep — drop only markers whose chunk you fully omitted. Do NOT
invent facts beyond the chunks. Do NOT add filler ("Based on the above…").

OUTPUT: just the paragraph. No headers, no JSON, no preamble.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000d07",
    key: "audit-gov.diagnose",
    description:
      "Failure-cluster diagnosis prompt for the Singularity Engine. Was hardcoded in audit-governance-service/engine/diagnose.ts:73-90.",
    content: `You are a production agent debugging expert for the Singularity AI agent platform.

You will receive clustered failure data from production traces. Your job is to:
1. Identify the root cause of the failure pattern
2. Classify the fix type (prompt change, tool description fix, config change, code fix)
3. Propose a specific, actionable fix
4. Suggest what an automated evaluator should check to prevent regression

Respond ONLY in valid JSON matching this schema:
{
  "root_cause": "Clear explanation of why the failures are occurring",
  "confidence": "high|medium|low",
  "category": "The failure category",
  "fix_type": "prompt|tool_description|config|code|unknown",
  "fix_summary": "One-line summary of the proposed fix",
  "fix_detail": "Detailed description of exactly what to change",
  "evaluator_hint": "What an automated evaluator should check for"
}`,
  },
];

async function upsertSystemPrompt(input: {
  id: string;
  key: string;
  content: string;
  description: string;
  modelHint?: string;
}) {
  await prisma.systemPrompt.upsert({
    where: { id: input.id },
    update: {
      key: input.key,
      content: input.content,
      description: input.description,
      modelHint: input.modelHint ?? null,
      isActive: true,
    },
    create: {
      id: input.id,
      key: input.key,
      version: 1,
      content: input.content,
      description: input.description,
      modelHint: input.modelHint ?? null,
      isActive: true,
    },
  });
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
  // M36.6 — optional per-execution context block, also Mustache-rendered
  // with the same vars as taskTemplate.
  extraContextTemplate?: string;
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
      extraContextTemplate: input.extraContextTemplate ?? null,
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
      extraContextTemplate: input.extraContextTemplate ?? null,
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

  // M36.3 — tool-policy layers. Composer attaches these to profiles whose
  // agents are expected to inspect code (localCodeIntelligencePolicy) or
  // make real code mutations (developerCodeMutationPolicy). Replaces
  // mcp-server/src/mcp/invoke.ts:854-880 inline system-message injection.
  await upsertLayer({
    id: IDS.layers.localCodeIntelligence,
    name: "Local Code Intelligence Tool Policy",
    layerType: "TOOL_CONTRACT",
    content: localCodeIntelligencePolicy,
    priority: 200,
    isRequired: false,
  });
  await upsertLayer({
    id: IDS.layers.developerCodeMutation,
    name: "Developer Code-Mutation Tool Policy",
    layerType: "TOOL_CONTRACT",
    content: developerCodeMutationPolicy,
    priority: 210,
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
    extraContextTemplate: loopDefaultExtraContext,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.LOOP_DEVELOPER,
    name: "Blueprint Loop Developer Stage Profile",
    description: "Developer-role override for the Blueprint Loop runner. Encodes the actual-code-change execution contract.",
    stageKey: "loop.stage",
    roleGate: "DEVELOPER",
    taskTemplate: loopDeveloperTask,
    extraContextTemplate: loopDeveloperExtraContext,
    roleLayerId: IDS.layers.role.DEVELOPER,
  });
  await upsertStageProfile({
    id: IDS.stageProfiles.LOOP_QA,
    name: "Blueprint Loop QA Stage Profile",
    description: "QA/test/verify-role override for the Blueprint Loop runner.",
    stageKey: "loop.stage",
    roleGate: "QA",
    taskTemplate: loopQaTask,
    extraContextTemplate: loopDefaultExtraContext,
    roleLayerId: IDS.layers.role.QA,
  });

  // M36.3 — attach tool-policy layers to the stage profiles that need them.
  // The blueprint developer is SIMULATED (no real mutation), so it gets
  // localCodeIntelligence but NOT developerCodeMutation. Only LOOP_DEVELOPER
  // gets the mutation policy because that's the real-code-edit path.
  await linkLayer(IDS.stageProfiles.BLUEPRINT_ARCHITECT,  IDS.layers.localCodeIntelligence, 200);
  await linkLayer(IDS.stageProfiles.BLUEPRINT_DEVELOPER,  IDS.layers.localCodeIntelligence, 200);
  await linkLayer(IDS.stageProfiles.BLUEPRINT_QA,         IDS.layers.localCodeIntelligence, 200);
  await linkLayer(IDS.stageProfiles.LOOP_DEFAULT,         IDS.layers.localCodeIntelligence, 200);
  await linkLayer(IDS.stageProfiles.LOOP_DEVELOPER,       IDS.layers.localCodeIntelligence, 200);
  await linkLayer(IDS.stageProfiles.LOOP_QA,              IDS.layers.localCodeIntelligence, 200);
  // Only the real-mutation path gets the mutation policy.
  await linkLayer(IDS.stageProfiles.LOOP_DEVELOPER,       IDS.layers.developerCodeMutation, 210);

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

  // M36.4 — seed the 7 single-shot SystemPrompts (was hardcoded across
  // workgraph-api, agent-service, tool-service, agent-runtime, audit-gov,
  // prompt-composer itself).
  for (const prompt of SYSTEM_PROMPTS) {
    await upsertSystemPrompt(prompt);
  }

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
