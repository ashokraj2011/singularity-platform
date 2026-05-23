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
    LOOP_INTAKE:         "00000000-0000-0000-0000-0000000000f7",
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
    LOOP_INTAKE:         "00000000-0000-0000-0000-0000000000e7",
    LOOP_PRODUCT_OWNER:  "00000000-0000-0000-0000-0000000000e8",
  },
  // M71 — StagePolicy rows. Stable UUIDs (71-74 mirrors the milestone) so
  // re-seed is idempotent. One row per (stageKey, agentRole) covering the
  // 4-stage workbench loop: STORY_INTAKE → DESIGN → DEVELOP → QA.
  stagePolicies: {
    INTAKE:    "00000000-0000-0000-0000-000000000071",
    DESIGN:    "00000000-0000-0000-0000-000000000072",
    DEVELOP:   "00000000-0000-0000-0000-000000000073",
    QA:        "00000000-0000-0000-0000-000000000074",
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
  "- Inspect the workspace with MCP code tools, modify partial file ranges with apply_patch, replace_text, or replace_range; use write_file only when providing the complete replacement file body. Finish with git_commit or finish_work_branch.",
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
  "Create a governed developer implementation for: {{goal}}",
  "Use the writable MCP workspace when available. Inspect relevant code first, then apply the requested change with tool calls and finish the work branch so a real MCP/git diff is captured.",
  "If no writable workspace is available, clearly state that no actual code change was captured and do not invent a patch.",
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
  // M41.2 — Operator chat thread. The local renderer supports simple
  // {{var}} substitution, so the caller supplies "- No operator guidance."
  // when the thread is empty.
  "Operator guidance (chronological — most recent last):",
  "{{operatorChat}}",
  "",
  "Treat operator guidance as a binding constraint for this attempt. If a guidance line conflicts with the captured stakeholder decisions, prefer the operator guidance and call out the conflict in your response.",
  "",
  "Do not ask an open question if the captured stakeholder decisions already answer the same intent. Reuse those answers as constraints for this stage.",
  "",
  "Return concise, structured workbench output with: decisions, risks, artifact updates for every expected artifact, only genuinely new open questions, and a gate recommendation of PASS, NEEDS_REWORK, or BLOCKED.",
].join("\n");

const loopIntakeTask = [
  "Run Workbench story intake: {{stageLabel}}",
  "",
  "Goal:",
  "{{goal}}",
  "",
  "Stage policy:",
  "- Context policy: {{stageContextPolicy}}",
  "- Tool policy: {{stageToolPolicy}}",
  "- Repo access: {{stageRepoAccess}}",
  "",
  "Stage description:",
  "{{stageDescription}}",
  "",
  "Expected intake artifacts:",
  "{{artifacts}}",
  "",
  "Configured intake questions:",
  "{{questions}}",
  "",
  "Captured stakeholder decisions and clarifications:",
  "{{capturedDecisions}}",
  "",
  "Operator guidance:",
  "{{operatorChat}}",
  "",
  "Intake rules:",
  "- Capture only the business story, user value, scope, acceptance criteria, priority, urgency, risks, and open clarification questions.",
  "- Do not inspect, mention, infer, or request repository files, source snapshots, branches, code symbols, tests, package manifests, or tool output.",
  "- If implementation details are needed, write them as questions for the Plan stage instead of guessing.",
  "",
  "Return concise, structured story intake output with: story brief, acceptance contract, in-scope/out-of-scope notes, assumptions, risks, open questions, and a gate recommendation of PASS, NEEDS_REWORK, or BLOCKED.",
].join("\n");

// Developer-specific extension to the loop task. Encodes the "you must
// actually mutate files" execution contract that was hardcoded in
// blueprint.router.ts:2335-2343.
const loopDeveloperTask = [
  loopDefaultTask,
  "",
  "Approved artifact context for implementation:",
  "{{priorApprovedArtifacts}}",
  "",
  "Implementation directive:",
  "{{implementationDirective}}",
  "",
  "Developer execution contract:",
  "- Treat captured stakeholder decisions and prior approved artifacts as implementation requirements.",
  "- Produce an actual MCP/git code change when a writable workspace is available; do not stop at design or planning text.",
  "- Inspect with AST/search/read tools, then mutate partial edits with apply_patch, replace_text, or replace_range; use write_file only for full-file replacements.",
  // M70.4 — Test baseline. Upstream main branches often have pre-
  // existing test failures unrelated to your change. The approval
  // gate treats EVERY failing test in your post-edit run_test as a
  // regression, so without a baseline a single pre-existing
  // NullPointerException somewhere else in the test suite will block
  // your perfectly-good edit. Captured this on the RuleEngine workflow
  // (testIsNotNull / testIsNull both NPE on Map.of with null) — fixed
  // by making the baseline call explicit in the prompt.
  "- BASELINE THE TESTS FIRST: BEFORE any code edit, call capture_test_baseline with the same command you'll use for run_test later (e.g. `mvn test`). This records which tests are currently broken so they don't masquerade as regressions caused by your change. Skipping this turns every pre-existing test failure on main into a gate-blocking 'regression'.",
  // M68 — Mandatory verification step. The formal-verifier gate at
  // finish_work_branch will BLOCK any commit that lacks a passing
  // verification receipt; skipping run_test wastes the entire stage's
  // tokens on a guaranteed-fail finish. Sequence is non-negotiable.
  "- MANDATORY ORDERING: capture_test_baseline (in EXPLORE, before edits) → mutations (apply_patch/replace_text/replace_range/write_file) → run_test (with the same command as the baseline) → finish_work_branch. The formal verifier blocks the commit if no passing receipt exists, and the approval gate blocks if your post-edit run_test has failures not in the baseline.",
  "- If no test target exists for this change (e.g. infrastructure-only edit), call verification_unavailable with a clear reason. Do NOT proceed to finish_work_branch without either a passing receipt or a verification_unavailable acknowledgement.",
  "- Use the recommended_verification tool to discover which test/lint command applies, then RUN that command — do not just read its output.",
  "- Finish with git_commit or finish_work_branch ONLY after the verification step above completes. Code Review then receives both the diff AND the verification evidence.",
  "- If the requested behavior already exists, add or update tests/docs that prove it and commit those changes.",
  "- Do not ask for a more specific task when prior approved artifacts define implementable behavior. Ask only when those artifacts are genuinely contradictory or unsafe.",
  // M70.2 — Force the agent to actually consult the prior-attempt
  // learnings block before doing anything. Without this nudge the
  // model treated the section as decorative context and repeated the
  // exact same failure across 4 retries (~$0.85 wasted per workflow).
  "",
  "If a 'Prior attempt learnings' section appears in this task: READ IT FIRST. It contains the actual failure reason from your previous attempt. Common patterns:",
  "  - 'The test filter matched ZERO methods' → your -Dtest filter is wrong. Either rename the filter to match a real method, or write the test method first before running the filter.",
  "  - 'Formal verifier: BLOCKED — no verification receipt' → you did not call run_test (or its output had no test results). Run the actual test for the change before finish_work_branch.",
  "  - 'Files claimed but NOT touched' → you mentioned editing files you never actually changed. Open those files and make the edit before finishing.",
  "  - 'Tests run: N, Failures: 0, Errors: 2' or any non-zero failures/errors in tests UNRELATED to your change → these are pre-existing failures on main. Call capture_test_baseline EARLY in this attempt (in EXPLORE, before any edit), using the same command, to anchor them. The gate will then ignore pre-existing failures and only block on NEW regressions.",
  "Do NOT repeat the same approach that failed last time. State explicitly in your response what you are doing differently from the prior attempt.",
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
  "- Use AST/search/read tools to locate the correct source files, then use apply_patch, replace_text, or replace_range for partial edits; use write_file for complete file bodies.",
  // M68 — Stronger verification mandate. Previous soft guidance ("run the
  // most focused relevant command WHEN a runnable test tool is available")
  // let the agent skip tests routinely, blowing 4 retries and ~$0.85 on
  // guaranteed-fail finish gates. The new rule is unconditional: produce
  // a passing receipt OR an explicit verification_unavailable; never
  // finish_work_branch with neither.
  "- VERIFICATION IS MANDATORY. After ANY mutation (apply_patch/replace_text/replace_range/write_file), call run_test with the most focused command from testing.detectedCommands or recommended_verification BEFORE finish_work_branch. The formal-verifier gate at finish_work_branch will block the commit unless state.verificationReceipts contains a passing entry — there is no soft path.",
  "- If testing.detectedCommands is empty AND recommended_verification cannot suggest a runnable command, you MAY emit verification_unavailable with the reason. This acknowledges the gap explicitly to the gate; without it, the gate blocks.",
  "- Sequence: mutate → run_test (or run_command/verification_unavailable) → finish_work_branch. Do not swap the order. Do not skip the middle step.",
  "- If Goal is generic, derive the concrete implementation from Approved artifact context in the current task. If behavior already exists, add focused tests/docs that prove it.",
  "- Do not fabricate changed files or patch text. If the writable workspace is missing or does not match the source, say that no actual code change was captured.",
  "Requested source: {{sourceType}} {{sourceUri}}{{sourceRefSuffix}}",
].join("\n");

const loopDefaultExtraContext =
  "Produce governed workbench artifacts and evidence. Use Source snapshot testing.detectedCommands for Dev/QA verification planning. Do not mutate source files unless this is the Developer stage with a verified writable MCP workspace.";

const loopIntakeExtraContext = [
  "Story intake execution policy:",
  "- This stage is intentionally story-only and repository-blind.",
  "- Do not use code tools, source snapshots, repo instructions, AST context, code context packages, or world-model code rules.",
  "- Focus on the WorkItem/story request, acceptance examples, constraints, scope boundaries, priority, risks, and missing product information.",
  "- Handoff implementation questions to the Plan stage; do not solve them here.",
].join("\n");

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
    id: "00000000-0000-0000-0000-000000000d09",
    key: "platform.context.singularity",
    description:
      "Structured platform-context document used by Event Horizon to ground answers about which app owns what. JSON-encoded (caller JSON.parse()'s content). Was hardcoded as the PLATFORM_CONTEXT object in workgraph-api/event-horizon.router.ts:28-62.",
    content: JSON.stringify({
      name: "Singularity",
      promise: "A governed agent operating system for capability-scoped work: workflows, agents, prompt context, MCP local execution, budgets, approvals, artifacts, and audit receipts.",
      primaryMentalModel: "Capability + Workflow + Budget Preset + Model Alias + MCP Workspace",
      apps: [
        { name: "Operations Portal", url: "http://localhost:5180", owns: "setup center, health, run audit, WorkItems, architecture diagrams, AI causality proof" },
        { name: "Identity & Access", url: "http://localhost:5175", owns: "users, teams, roles, permissions, IAM capabilities, memberships" },
        { name: "Agent Runtime", url: "http://localhost:3000", owns: "runtime capabilities, agent templates, agent studio, tools, prompt profiles, knowledge, learning review" },
        { name: "Workflow Manager", url: "http://localhost:5174", owns: "workflow design, workflow runs, runtime inbox, approvals, run insights, budgets, WorkItems, consumables" },
        { name: "Blueprint Workbench", url: "http://localhost:5176", owns: "staged agent work, human gates, artifact refinement, consumable final packs" },
      ],
      ownership: {
        IAM: "users, teams, roles, capability identity, membership and access decisions",
        Workgraph: "workflow templates/runs, WorkItems, approvals, consumables, run budgets and evidence",
        AgentRuntime: "agent templates, capability runtime assets, tools, prompt profile references, knowledge and learning candidates",
        PromptComposer: "prompt layers, context plans, citations and prompt assembly receipts",
        ContextFabric: "execution orchestration, token governor, memory, Context Fabric receipts",
        MCP: "local/private files, AST index, local tools, branches and commits; LLM calls go through the central gateway",
        AuditGovernance: "audit events, policy/rate/budget receipts and governance reports",
      },
      operatorWorkflows: [
        "Create/onboard a capability, optionally from GitHub or local repo.",
        "Activate a predefined capability agent team with locked governance/verifier/security gates.",
        "Design a governed workflow or delegate work through cross-capability WorkItems.",
        "Run workflow, inspect Mission Control/Run Insights, approve pauses and artifacts.",
        "Use Workbench for staged artifacts that become Workgraph consumables.",
        "Use Operations for audit reports, architecture diagrams and AI causality proof.",
      ],
      answerRules: [
        "Use the current page context first, then platform context.",
        "Explain where data lives and which app owns the next action.",
        "When evidence is missing, say what is missing and where to verify it.",
        "Do not claim a mutation happened unless the context includes a receipt or explicit result.",
      ],
    }, null, 2),
  },
  {
    id: "00000000-0000-0000-0000-000000000d08",
    key: "mcp.code-tool-use-nudge",
    description:
      "Mid-loop nudge appended by mcp-server when the LLM didn't call any tools but the run is in autonomous-mutation mode with a writable workspace. Was hardcoded in mcp-server/src/mcp/invoke.ts:216-235.",
    content: [
      "This is a Developer stage with a writable MCP workspace, but the previous answer did not call any tools.",
      "Use MCP tools now before answering in prose.",
      "Inspect the code with find_symbol, get_symbol, get_ast_slice, search_code, or read_file.",
      "Apply partial edits with apply_patch, replace_text, or replace_range; use write_file only with complete replacement file contents.",
      // M68 — Mid-loop reinforcement of the verification mandate. Without
      // a passing run_test receipt, finish_work_branch hits the formal
      // verifier gate and blocks the commit. Reminding the agent here
      // catches cases where the developer prompt was lost mid-context.
      "After mutations: call run_test (or run_command) BEFORE finish_work_branch so the formal-verifier gate has a passing verification receipt to inspect. Without it the gate WILL block your finish.",
      "Then create code-change evidence with git_commit or finish_work_branch.",
      "Do not call prepare_work_branch; the workflow branch is already prepared.",
      "If the behavior already exists, add or update tests/documentation and commit that evidence.",
    ].join("\n"),
  },
  {
    id: "00000000-0000-0000-0000-000000000d0a",
    key: "context-fabric.context-compiler.default-system",
    description:
      "Default system prompt used by context_memory_service when the caller doesn't supply one. Was DEFAULT_SYSTEM_PROMPT in context-fabric/services/context_memory_service/app/context_compiler.py:11.",
    content:
      "You are a helpful assistant using Context Fabric. Use the supplied optimized context carefully. If information is missing, say what is missing instead of inventing details.",
  },
  {
    id: "00000000-0000-0000-0000-000000000d0b",
    key: "context-fabric.summarizer.system",
    description:
      "System message for Context Fabric's session-summary engine — forces JSON-only output. Was hardcoded at context-fabric/services/context_memory_service/app/summarizer.py:102.",
    content: "You are Context Fabric's summarization engine. Return only valid JSON.",
  },
  {
    id: "00000000-0000-0000-0000-000000000d0c",
    key: "context-fabric.summarizer.user-template",
    description:
      "Mustache template for the user message Context Fabric's summarizer sends to the LLM. Vars: {{schemaKeys}}, {{conversation}}. Was f-string-built at context-fabric/services/context_memory_service/app/summarizer.py:86-99.",
    content: `You are Context Fabric's summarization engine.
Create a compact structured JSON summary of this session.
Return only valid JSON with these keys:
{{schemaKeys}}

Rules:
- Preserve decisions, requirements, constraints, open questions, and durable learning.
- Do not invent details.
- Keep each list concise.

Conversation:
{{conversation}}`,
  },
  {
    id: "00000000-0000-0000-0000-000000000d0d",
    key: "audit-gov.lesson-extract",
    description:
      "M38 — Lesson extractor for confirmed-resolved failure clusters. Given the failure summary + a successful retry trace, returns a 2-sentence rule, a confidence score, and the (capability_id, tool_name) it applies to.",
    content: `You are the Singularity Engine's Lessons Extractor.

You will receive:
  1. A summary of a production failure cluster that has been confirmed resolved (no new occurrences for the cooldown window).
  2. (Optional) An example trace where the same capability+tool succeeded after the failure.

Your job: extract a CONCISE, GENERALIZABLE rule (1-2 sentences, <=400 chars) that a future agent on the same capability should follow to avoid the failure pattern.

Constraints:
  - Be specific enough to be useful, abstract enough to apply broadly. Avoid trace-specific identifiers.
  - Reference the tool name and the corrective behavior, not the symptom.
  - If the failure looks like a single random fluke (one-off, no clear pattern), return confidence < 0.4 and a short rule anyway — caller may discard low-confidence rules.
  - If the failure pattern is too vague to write a useful rule, return rule_text with a short note and confidence 0.2.

Respond ONLY in valid JSON matching:
{
  "rule_text":  "1-2 sentence rule the agent should follow",
  "confidence": 0.0-1.0,
  "applies_to": { "capability_id": "...", "tool_name": "..." (optional) }
}`,
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

// ─────────────────────────────────────────────────────────────
// M71 — StagePolicy seed. One row per stage in the 4-stage workbench loop.
// Each policy carries stage-wide config (approval model, limits, context
// policy, edit policy, verification policy, risk policy) plus the per-phase
// rows (allowedTools + requiredOutputSchema).
//
// context-fabric loads ONE of these per /execute call and uses the per-phase
// allowedTools to refuse out-of-phase tool calls with PHASE_TOOL_FORBIDDEN.
// The shape mirrors §8 of singularity_governed_coding_loop_spec.md.
// ─────────────────────────────────────────────────────────────

interface SeedPhasePolicy {
  phase: "PLAN" | "EXPLORE" | "ACT" | "VERIFY" | "REPAIR" | "SELF_REVIEW" | "FINALIZE";
  allowedTools: string[];
  forbiddenTools?: string[];
  requiredOutputSchema: Record<string, unknown>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
}

interface SeedStagePolicy {
  id: string;
  stageKey: string;
  agentRole: string | null;
  description: string;
  approvalModel: Record<string, unknown>;
  limits: Record<string, unknown>;
  contextPolicy: Record<string, unknown>;
  editPolicy: Record<string, unknown>;
  verificationPolicy: Record<string, unknown>;
  riskPolicy: Record<string, unknown>;
  phases: SeedPhasePolicy[];
}

const STAGE_POLICIES: SeedStagePolicy[] = [
  // ── STORY_INTAKE — story-only, no repo or code tools ────────────────────
  {
    id: IDS.stagePolicies.INTAKE,
    stageKey: "loop.stage.intake",
    agentRole: "PRODUCT_OWNER",
    description: "Story-only intake stage. Tool-free. Captures business intent before any repo access.",
    approvalModel: {
      stage_completion: "requires_evidence_approval",
    },
    limits: {
      max_repair_attempts: 1,
      max_context_tokens: 8000,
      max_tool_calls: 0,
    },
    contextPolicy: { ast_first: false, full_file_read_requires_justification: true },
    editPolicy: { patch_first: false, write_file_existing_file: "forbidden" },
    verificationPolicy: { verification_required: false },
    riskPolicy: { external_side_effects_blocked_by_default: true },
    phases: [
      {
        phase: "PLAN",
        allowedTools: [],
        requiredOutputSchema: {
          required: ["story_brief", "acceptance_criteria"],
          properties: {
            story_brief: { type: "string" },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            open_questions: { type: "array", items: { type: "string" } },
          },
        },
      },
      {
        phase: "SELF_REVIEW",
        allowedTools: [],
        requiredOutputSchema: {
          required: ["recommended_for_approval"],
          properties: {
            recommended_for_approval: { type: "boolean" },
            risk_summary: { type: "object" },
          },
        },
      },
    ],
  },

  // ── DESIGN — read-only, architect produces solution architecture ────────
  {
    id: IDS.stagePolicies.DESIGN,
    stageKey: "loop.stage",
    agentRole: "ARCHITECT",
    description: "Design stage. Read-only repo access. Produces solution architecture + spec draft.",
    approvalModel: {
      stage_completion: "requires_evidence_approval",
    },
    limits: {
      max_repair_attempts: 2,
      max_full_file_reads: 8,
      max_context_tokens: 24000,
      max_tool_calls: 40,
    },
    contextPolicy: {
      ast_first: true,
      full_file_read_requires_justification: true,
      large_file_threshold_lines: 500,
      require_context_receipt: true,
    },
    editPolicy: { patch_first: true, write_file_existing_file: "forbidden", require_anchor_hash: true },
    verificationPolicy: { verification_required: false },
    riskPolicy: { external_side_effects_blocked_by_default: true },
    phases: [
      {
        phase: "PLAN",
        allowedTools: ["repo_map", "symbol_search", "list_files", "read_repo_instructions", "read_workitem"],
        requiredOutputSchema: {
          required: ["target_files", "symbols_to_inspect", "risk_level"],
          properties: {
            target_files: { type: "array" },
            symbols_to_inspect: { type: "array" },
            risk_level: { type: "string", enum: ["low", "medium", "high"] },
            external_side_effects_required: { type: "boolean" },
          },
        },
      },
      {
        phase: "EXPLORE",
        allowedTools: ["repo_map", "symbol_search", "find_symbol", "get_symbol", "get_ast_slice", "get_dependencies", "read_file", "read_test_file", "search_code", "grep_lines"],
        requiredOutputSchema: {
          required: ["context_used", "implementation_findings"],
          properties: {
            context_used: { type: "array" },
            implementation_findings: { type: "array" },
          },
        },
      },
      {
        phase: "SELF_REVIEW",
        allowedTools: ["read_file"],
        requiredOutputSchema: {
          required: ["recommended_for_approval", "risk_summary"],
          properties: {
            recommended_for_approval: { type: "boolean" },
            risk_summary: { type: "object" },
            diff_summary: { type: "object" },
          },
        },
      },
    ],
  },

  // ── DEVELOP — full 7-phase loop, code mutation + verification ───────────
  {
    id: IDS.stagePolicies.DEVELOP,
    stageKey: "loop.stage",
    agentRole: "DEVELOPER",
    description: "Developer stage. Full 7-phase loop. Patch-first edits + mandatory verification.",
    approvalModel: {
      local_sandbox_edits: "auto",
      stage_completion: "requires_evidence_approval",
      push: "requires_human_approval",
      deploy: "requires_human_approval",
      external_side_effects: "requires_human_approval",
    },
    limits: {
      max_repair_attempts: 3,
      max_full_file_reads: 5,
      max_context_tokens: 24000,
      max_tool_calls: 80,
      max_changed_files_without_escalation: 10,
      max_diff_lines_without_escalation: 800,
    },
    contextPolicy: {
      ast_first: true,
      full_file_read_requires_justification: true,
      large_file_threshold_lines: 500,
      require_context_receipt: true,
    },
    editPolicy: {
      patch_first: true,
      write_file_existing_file: "forbidden",
      require_anchor_hash: true,
      generated_file_requires_marker: true,
    },
    verificationPolicy: {
      verification_required: true,
      allow_unavailable_with_reason: true,
      require_test_discovery: true,
      require_fallback_if_no_tests: true,
    },
    riskPolicy: {
      high_risk_requires_architect_review: true,
      security_sensitive_requires_security_review: true,
      external_side_effects_blocked_by_default: true,
    },
    phases: [
      {
        phase: "PLAN",
        allowedTools: ["repo_map", "symbol_search", "list_files", "read_repo_instructions", "read_workitem"],
        requiredOutputSchema: {
          required: ["target_files", "expected_edits", "test_strategy", "risk_level"],
          properties: {
            target_files: { type: "array" },
            expected_edits: { type: "array" },
            symbols_to_inspect: { type: "array" },
            test_strategy: {
              type: "object",
              required: ["commands"],
              properties: {
                commands: { type: "array", items: { type: "string" } },
                reason: { type: "string" },
              },
            },
            risk_level: { type: "string", enum: ["low", "medium", "high"] },
            external_side_effects_required: { type: "boolean" },
          },
        },
      },
      {
        phase: "EXPLORE",
        allowedTools: ["repo_map", "symbol_search", "find_symbol", "get_symbol", "get_ast_slice", "get_dependencies", "read_file", "read_test_file", "search_code", "grep_lines", "capture_test_baseline"],
        requiredOutputSchema: {
          required: ["context_used", "implementation_findings"],
          properties: {
            context_used: { type: "array" },
            implementation_findings: { type: "array" },
            updated_target_files: { type: "array" },
          },
        },
      },
      {
        phase: "ACT",
        allowedTools: ["apply_patch", "replace_text", "replace_range", "create_file", "write_file", "read_file", "get_ast_slice"],
        forbiddenTools: ["shell_unrestricted", "network_call", "push_branch", "deploy"],
        requiredOutputSchema: {
          required: ["edits"],
          properties: {
            edits: {
              type: "array",
              items: {
                type: "object",
                required: ["file", "edit_type", "reason"],
                properties: {
                  file: { type: "string" },
                  edit_type: { type: "string", enum: ["apply_patch", "replace_text", "replace_range", "create_file", "write_file"] },
                  reason: { type: "string" },
                  anchor_hash: { type: "string" },
                },
              },
            },
          },
        },
      },
      {
        phase: "VERIFY",
        allowedTools: ["run_test", "run_command", "verification_unavailable", "recommended_verification", "git_diff", "changed_files"],
        requiredOutputSchema: {
          required: ["verification_result"],
          properties: {
            verification_result: {
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["passed", "failed", "unavailable"] },
                commands_run: { type: "array" },
                coverage: { type: "object" },
              },
            },
          },
        },
      },
      {
        phase: "REPAIR",
        allowedTools: ["read_file", "get_ast_slice", "apply_patch", "replace_text", "replace_range", "run_test", "run_command"],
        requiredOutputSchema: {
          required: ["retry_number", "failure_summary", "repair_hypothesis"],
          properties: {
            retry_number: { type: "integer" },
            failure_summary: { type: "string" },
            repair_hypothesis: { type: "string" },
            edits: { type: "array" },
          },
        },
      },
      {
        phase: "SELF_REVIEW",
        allowedTools: ["git_diff", "changed_files", "read_file"],
        requiredOutputSchema: {
          required: ["recommended_for_approval", "acceptance_criteria_check", "risk_summary", "verification_summary"],
          properties: {
            recommended_for_approval: { type: "boolean" },
            acceptance_criteria_check: {
              type: "array",
              items: {
                type: "object",
                required: ["criterion", "status"],
                properties: {
                  criterion: { type: "string" },
                  status: { type: "string", enum: ["met", "not_met", "uncertain"] },
                  evidence: { type: "string" },
                },
              },
            },
            risk_summary: { type: "object" },
            diff_summary: { type: "object" },
            verification_summary: { type: "string" },
          },
        },
      },
      {
        phase: "FINALIZE",
        allowedTools: ["finish_work_branch", "git_commit", "prepare_pull_request"],
        forbiddenTools: ["push_branch", "deploy"],
        requiredOutputSchema: {
          required: ["branch_name", "commit_sha"],
          properties: {
            branch_name: { type: "string" },
            commit_sha: { type: "string" },
            pull_request_url: { type: "string" },
          },
        },
      },
    ],
  },

  // ── QA — verification-focused, no mutation ──────────────────────────────
  {
    id: IDS.stagePolicies.QA,
    stageKey: "loop.stage",
    agentRole: "QA",
    description: "QA stage. Verification + traceability. No code mutation; reads diffs and runs tests.",
    approvalModel: {
      stage_completion: "requires_evidence_approval",
    },
    limits: {
      max_repair_attempts: 2,
      max_full_file_reads: 10,
      max_context_tokens: 24000,
      max_tool_calls: 40,
    },
    contextPolicy: {
      ast_first: true,
      full_file_read_requires_justification: true,
      require_context_receipt: true,
    },
    editPolicy: { patch_first: false, write_file_existing_file: "forbidden", require_anchor_hash: false },
    verificationPolicy: {
      verification_required: true,
      allow_unavailable_with_reason: true,
      require_test_discovery: true,
    },
    riskPolicy: { external_side_effects_blocked_by_default: true },
    phases: [
      {
        phase: "PLAN",
        allowedTools: ["repo_map", "symbol_search", "list_files", "read_repo_instructions", "read_workitem", "changed_files", "git_diff"],
        requiredOutputSchema: {
          required: ["target_files", "test_strategy"],
          properties: {
            target_files: { type: "array" },
            test_strategy: {
              type: "object",
              required: ["commands"],
              properties: {
                commands: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      {
        phase: "EXPLORE",
        allowedTools: ["read_file", "read_test_file", "get_ast_slice", "search_code", "grep_lines", "changed_files", "git_diff"],
        requiredOutputSchema: {
          required: ["context_used"],
          properties: { context_used: { type: "array" } },
        },
      },
      {
        phase: "VERIFY",
        allowedTools: ["run_test", "run_command", "recommended_verification", "verification_unavailable", "git_diff", "changed_files"],
        requiredOutputSchema: {
          required: ["verification_result"],
          properties: {
            verification_result: {
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["passed", "failed", "unavailable"] },
                commands_run: { type: "array" },
              },
            },
          },
        },
      },
      {
        phase: "SELF_REVIEW",
        allowedTools: ["read_file", "git_diff", "changed_files"],
        requiredOutputSchema: {
          required: ["recommended_for_approval", "acceptance_criteria_check", "verification_summary"],
          properties: {
            recommended_for_approval: { type: "boolean" },
            acceptance_criteria_check: {
              type: "array",
              items: {
                type: "object",
                required: ["criterion", "status"],
                properties: {
                  criterion: { type: "string" },
                  status: { type: "string", enum: ["met", "not_met", "uncertain"] },
                  evidence: { type: "string" },
                },
              },
            },
            verification_summary: { type: "string" },
            traceability_matrix: { type: "object" },
          },
        },
      },
    ],
  },
];

async function upsertStagePolicy(input: SeedStagePolicy): Promise<void> {
  await prisma.stagePolicy.upsert({
    where: { id: input.id },
    update: {
      stageKey:           input.stageKey,
      agentRole:          input.agentRole,
      status:             "ACTIVE",
      description:        input.description,
      approvalModel:      input.approvalModel as never,
      limits:             input.limits as never,
      contextPolicy:      input.contextPolicy as never,
      editPolicy:         input.editPolicy as never,
      verificationPolicy: input.verificationPolicy as never,
      riskPolicy:         input.riskPolicy as never,
    },
    create: {
      id:                 input.id,
      stageKey:           input.stageKey,
      agentRole:          input.agentRole,
      version:            1,
      status:             "ACTIVE",
      description:        input.description,
      approvalModel:      input.approvalModel as never,
      limits:             input.limits as never,
      contextPolicy:      input.contextPolicy as never,
      editPolicy:         input.editPolicy as never,
      verificationPolicy: input.verificationPolicy as never,
      riskPolicy:         input.riskPolicy as never,
    },
  });
  // Atomic replace of phase rows — every re-seed lands a clean set.
  await prisma.stagePhasePolicy.deleteMany({ where: { stagePolicyId: input.id } });
  if (input.phases.length > 0) {
    await prisma.stagePhasePolicy.createMany({
      data: input.phases.map((p) => ({
        stagePolicyId:        input.id,
        phase:                p.phase,
        allowedTools:         p.allowedTools,
        forbiddenTools:       p.forbiddenTools ?? [],
        requiredOutputSchema: p.requiredOutputSchema as never,
        maxInputTokens:       p.maxInputTokens ?? null,
        maxOutputTokens:      p.maxOutputTokens ?? null,
        maxToolCalls:         p.maxToolCalls ?? null,
      })),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// M36.5 — EventHorizonAction catalog. Was duplicated across 3 SPA
// EventHorizonChat.tsx files with identical shape but different action
// sets per surface. Centralised here; each SPA fetches its slice from
// GET /api/v1/event-horizon-actions?surface=<key>.
// ─────────────────────────────────────────────────────────────

const EVENT_HORIZON_ACTIONS: Array<{
  id: string;
  surface: string;
  intent: string;
  label: string;
  prompt: string;
  displayOrder: number;
  description: string;
}> = [
  // workflow-manager (workgraph-studio/apps/web/EventHorizonChat.tsx:106-112)
  {
    id: "00000000-0000-0000-0000-000000001001",
    surface: "workflow-manager",
    intent: "summarize_run",
    label: "Summarize run",
    prompt: "Summarize this run, including current status, active waits, budget risk, and next operator action.",
    displayOrder: 10,
    description: "Quick run summary for the Workflow Manager.",
  },
  {
    id: "00000000-0000-0000-0000-000000001002",
    surface: "workflow-manager",
    intent: "explain_stuck_nodes",
    label: "Explain stuck nodes",
    prompt: "Find any stuck, failed, paused, or waiting nodes and explain likely causes and what to inspect next.",
    displayOrder: 20,
    description: "Diagnose stuck/failed/waiting nodes.",
  },
  {
    id: "00000000-0000-0000-0000-000000001003",
    surface: "workflow-manager",
    intent: "find_evidence",
    label: "Find evidence",
    prompt: "Tell me where to inspect prompt assemblies, model receipts, citations, artifacts, code changes, and audit evidence for this run.",
    displayOrder: 30,
    description: "Point at evidence surfaces (prompts, receipts, artifacts).",
  },
  {
    id: "00000000-0000-0000-0000-000000001004",
    surface: "workflow-manager",
    intent: "draft_approval_note",
    label: "Draft approval note",
    prompt: "Draft a concise approval note for the current pending approval or artifact promotion, including risks to check before approving.",
    displayOrder: 40,
    description: "Compose an approval note with risk callouts.",
  },
  {
    id: "00000000-0000-0000-0000-000000001005",
    surface: "workflow-manager",
    intent: "recommend_budget_model",
    label: "Budget/model advice",
    prompt: "Review token budget and model choice for this context and recommend safer or cheaper settings if needed.",
    displayOrder: 50,
    description: "Recommend token-budget + model alias tuning.",
  },
  // capability-admin (agent-and-tools/web/components/EventHorizonChat.tsx:95-101)
  {
    id: "00000000-0000-0000-0000-000000001011",
    surface: "capability-admin",
    intent: "explain_capability",
    label: "Explain capability",
    prompt: "Explain this capability setup, including agents, bindings, learning review, and what still needs approval.",
    displayOrder: 10,
    description: "Walk through the active capability's agents/bindings/gates.",
  },
  {
    id: "00000000-0000-0000-0000-000000001012",
    surface: "capability-admin",
    intent: "find_runtime_evidence",
    label: "Find evidence",
    prompt: "Tell me where to inspect runtime receipts, workflow evidence, prompt assemblies, artifacts, and audit receipts for this capability.",
    displayOrder: 20,
    description: "Point at runtime evidence surfaces.",
  },
  {
    id: "00000000-0000-0000-0000-000000001013",
    surface: "capability-admin",
    intent: "draft_review_note",
    label: "Draft review note",
    prompt: "Draft a concise human review note for activating generated agents or materializing learned knowledge.",
    displayOrder: 30,
    description: "Compose a review note for agent activation / knowledge promotion.",
  },
  {
    id: "00000000-0000-0000-0000-000000001014",
    surface: "capability-admin",
    intent: "recommend_agent_team",
    label: "Agent team advice",
    prompt: "Recommend the right agent team, roles, tools, and artifact gates for this capability.",
    displayOrder: 40,
    description: "Suggest the agent team composition.",
  },
  {
    id: "00000000-0000-0000-0000-000000001015",
    surface: "capability-admin",
    intent: "explain_prompt_stack",
    label: "Prompt stack",
    prompt: "Explain the prompt profile/layer stack for this screen in user-friendly terms and call out what is editable.",
    displayOrder: 50,
    description: "Explain the prompt profile/layer stack for the current screen.",
  },
];

async function upsertEventHorizonAction(input: typeof EVENT_HORIZON_ACTIONS[number]) {
  await prisma.eventHorizonAction.upsert({
    where: { id: input.id },
    update: {
      surface: input.surface,
      intent: input.intent,
      label: input.label,
      prompt: input.prompt,
      displayOrder: input.displayOrder,
      isActive: true,
      description: input.description,
    },
    create: {
      id: input.id,
      surface: input.surface,
      intent: input.intent,
      label: input.label,
      prompt: input.prompt,
      displayOrder: input.displayOrder,
      isActive: true,
      description: input.description,
    },
  });
}

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
    id: IDS.stageProfiles.LOOP_INTAKE,
    name: "Blueprint Loop Intake Stage Profile",
    description: "Story-only Workbench intake profile. It deliberately excludes repo/source/code-tool guidance.",
    stageKey: "loop.stage.intake",
    roleGate: "PRODUCT_OWNER",
    taskTemplate: loopIntakeTask,
    extraContextTemplate: loopIntakeExtraContext,
    roleLayerId: IDS.layers.role.PRODUCT_OWNER,
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
  // LOOP_INTAKE intentionally has no localCodeIntelligence layer: Intake is
  // story/business-only and must not receive repo/source/code-tool guidance.
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
    id: IDS.stageBindings.LOOP_INTAKE,
    stageKey: "loop.stage.intake",
    agentRole: null,
    promptProfileId: IDS.stageProfiles.LOOP_INTAKE,
    description: "Loop stage — story-only Intake profile.",
  });
  await upsertBinding({
    id: IDS.stageBindings.LOOP_PRODUCT_OWNER,
    stageKey: "loop.stage",
    agentRole: "PRODUCT_OWNER",
    promptProfileId: IDS.stageProfiles.LOOP_INTAKE,
    description: "Loop stage fallback — PRODUCT_OWNER role uses story-only Intake prompt unless a stage-specific binding overrides it.",
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

  // M36.5 — seed the EventHorizonAction catalog (was duplicated across 3 SPAs).
  for (const action of EVENT_HORIZON_ACTIONS) {
    await upsertEventHorizonAction(action);
  }

  // M71 — seed the 4 StagePolicies (intake/design/develop/qa). context-fabric
  // loads these at /execute time and enforces them as hard refuses
  // (PHASE_TOOL_FORBIDDEN). Atomic — each upsert replaces the phase rows.
  for (const policy of STAGE_POLICIES) {
    await upsertStagePolicy(policy);
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
