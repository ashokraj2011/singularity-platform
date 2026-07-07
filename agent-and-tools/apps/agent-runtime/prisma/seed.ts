// M29 — per-service Prisma client output. seed.ts is invoked from the
// prisma/ dir, so the generated client is one level up.
import { PrismaClient } from "../generated/prisma-client";

const prisma = new PrismaClient();

// M29 — sha helper and createHash import removed; prompt-layer seeding
// (which used content-hashing) moved to prompt-composer's seed.

// Stable, valid-UUID ids for seed entities
const IDS = {
  layers: {
    platformConstitution: "00000000-0000-0000-0000-0000000000c1",
    outputContract:       "00000000-0000-0000-0000-0000000000c2",
    role: {
      ARCHITECT:  "00000000-0000-0000-0000-0000000000a1",
      DEVELOPER:  "00000000-0000-0000-0000-0000000000a2",
      QA:         "00000000-0000-0000-0000-0000000000a3",
      GOVERNANCE: "00000000-0000-0000-0000-0000000000a4",
      SECURITY:   "00000000-0000-0000-0000-0000000000a5",
      DEVOPS:     "00000000-0000-0000-0000-0000000000a6",
      PRODUCT_OWNER: "00000000-0000-0000-0000-0000000000a7",
    },
  },
  profiles: {
    ARCHITECT:  "00000000-0000-0000-0000-0000000000b1",
    DEVELOPER:  "00000000-0000-0000-0000-0000000000b2",
    QA:         "00000000-0000-0000-0000-0000000000b3",
    GOVERNANCE: "00000000-0000-0000-0000-0000000000b4",
    SECURITY:   "00000000-0000-0000-0000-0000000000b5",
    DEVOPS:     "00000000-0000-0000-0000-0000000000b6",
    PRODUCT_OWNER: "00000000-0000-0000-0000-0000000000b7",
  },
  templates: {
    ARCHITECT:  "00000000-0000-0000-0000-0000000000d1",
    DEVELOPER:  "00000000-0000-0000-0000-0000000000d2",
    QA:         "00000000-0000-0000-0000-0000000000d3",
    GOVERNANCE: "00000000-0000-0000-0000-0000000000d4",
    SECURITY:   "00000000-0000-0000-0000-0000000000d5",
    DEVOPS:     "00000000-0000-0000-0000-0000000000d6",
    PRODUCT_OWNER: "00000000-0000-0000-0000-0000000000d7",
    BUSINESS_ANALYST: "00000000-0000-0000-0000-0000000000d8",
  },
  tools: {
    repoSearch:        "00000000-0000-0000-0000-0000000000e1",
    repoRead:          "00000000-0000-0000-0000-0000000000e2",
    documentRead:      "00000000-0000-0000-0000-0000000000e3",
    deploymentExecute: "00000000-0000-0000-0000-0000000000e4",
  },
};

async function main() {
  console.log("[seed] starting");

  // M29 — PromptLayer/PromptProfile/PromptProfileLayer seeding moved to
  // prompt-composer's seed (composer owns the prompt tables). agent-runtime
  // only seeds AgentTemplate rows here; the basePromptProfileId references
  // a UUID that composer's seed creates, so the FK is stable even though
  // the row lives in composer's authoritative schema.
  // NOTE: `content` here is stored as AgentTemplate.description (display +
  // derivation root), NOT the operative LLM prompt. The authoritative agent
  // ROLE/STAGE prompts live in prompt-composer (PromptLayer/StagePromptBinding,
  // seeded in agent-and-tools/apps/prompt-composer/prisma/seed.ts). Keep these
  // descriptions roughly in step with composer's role contracts, but composer
  // is the single source of truth — editing here does NOT change run behavior.
  const roleContracts: Array<{ role: keyof typeof IDS.templates; profileRole?: keyof typeof IDS.profiles; name: string; content: string }> = [
    { role: "ARCHITECT", name: "Architect Role Contract", content: "You are an Architect Agent. Analyze design, dependencies, risks, and tradeoffs. Never approve or deploy your own recommendations." },
    { role: "DEVELOPER", name: "Developer Role Contract", content: "You are a Developer Agent. Implement changes safely, write code AND the unit tests that cover it (run them), prefer small reversible steps." },
    { role: "QA",        name: "QA Role Contract",         content: "You are a QA Agent. Identify regressions, edge cases, performance risks, and missing test coverage." },
    { role: "GOVERNANCE", name: "Governance Role Contract", content: "You are a Governance Agent. Verify approvals, audits, security, and compliance. You can block release." },
    { role: "SECURITY", name: "Security Role Contract", content: "You are a Security Agent. Threat-model the change, check authorization, data exposure, dependency risk, and evidence before approval." },
    { role: "DEVOPS", name: "DevOps Role Contract", content: "You are a DevOps Agent. Validate deployability, observability, rollback, environment readiness, and operational risk." },
    { role: "PRODUCT_OWNER", name: "Product Owner Role Contract", content: "You are a Product Owner Agent. Clarify outcomes, acceptance criteria, user impact, release scope, and approval readiness." },
    { role: "BUSINESS_ANALYST", profileRole: "PRODUCT_OWNER", name: "Business Analyst Role Contract", content: "You are a Business Analyst Agent. Extract business rules, process impact, domain vocabulary, acceptance details, and open questions from approved capability sources." },
  ];

  // ── Copilot executor grant ────────────────────────────────────────────────
  // The SDLC (Copilot CLI) workflow's AGENT_TASK nodes bind these common role
  // templates and dispatch the `copilot_execute` tool. The MCP effective-capability
  // gate (mcp-server/src/mcp/effective-capability.ts) only allows a tool the agent
  // PROFILE actually grants — resolved from AgentTemplateSkill bindings by
  // resolveProfile(). With no `copilot_execute` skill bound, that set is empty and
  // the gate denies copilot_execute for EVERY capability ("effective capability set
  // required"). Seed the skill once and bind it (invoke) to each common role
  // template below, so any capability's governed Copilot run is authorized — the
  // SDLC copilot workflow is capability-independent and reuses these templates, so
  // this covers onboarded capabilities too (no per-capability wiring needed).
  const COPILOT_EXECUTE_SKILL_ID = "5ce00000-0000-0000-0000-0000000000ce";
  await prisma.agentSkill.upsert({
    where: { id: COPILOT_EXECUTE_SKILL_ID },
    update: { name: "copilot_execute", skillType: "tool", status: "ACTIVE" },
    create: {
      id: COPILOT_EXECUTE_SKILL_ID,
      name: "copilot_execute",
      skillType: "tool",
      description:
        "Dispatch the Copilot CLI executor (copilot_execute) on the connected runtime. Bound to the common SDLC role templates so governed Copilot phases are authorized to invoke it.",
    },
  });

  for (const rc of roleContracts) {
    const profileRole = (rc.profileRole ?? rc.role) as keyof typeof IDS.profiles;
    const profileId = IDS.profiles[profileRole];
    const templateId = IDS.templates[rc.role];
    const templateName = `${titleRole(rc.role)} Agent`;
    await prisma.agentTemplate.upsert({
      where: { id: templateId },
      // M23 — re-stamp the lockedReason on every seed run so older databases
      // pick up the governance flag without a manual migration.
      update: {
        name: templateName,
        roleType: rc.role,
        basePromptProfileId: profileId,
        description: rc.content,
        status: "ACTIVE",
        lockedReason: "common platform baseline",
      },
      create: {
        id: templateId,
        name: templateName,
        roleType: rc.role, basePromptProfileId: profileId,
        description: rc.content, status: "ACTIVE",
        // capabilityId stays NULL — these are common-library baselines.
        // baseTemplateId stays NULL — they are roots of the derivation tree.
        lockedReason: "common platform baseline",
      },
    });

    // Bind copilot_execute (read+invoke) to this common role template so the
    // governed Copilot SDLC phases can dispatch it. Deterministic id per template
    // keeps it idempotent across re-seeds.
    const copilotLinkId = `5ce00000-0000-0000-0000-0000000000${templateId.slice(-2)}`;
    await prisma.agentTemplateSkill.upsert({
      where: { id: copilotLinkId },
      update: { isDefault: true, permissions: ["read", "invoke"], sourceType: "local", readOnly: false },
      create: {
        id: copilotLinkId,
        agentTemplateId: templateId,
        skillId: COPILOT_EXECUTE_SKILL_ID,
        isDefault: true,
        sourceType: "local",
        permissions: ["read", "invoke"],
        readOnly: false,
      },
    });
  }

  // Tools
  const tools: Array<{ id: string; ns: string; name: string; description: string; type: string; risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; inputSchema: Record<string, unknown> }> = [
    { id: IDS.tools.repoSearch, ns: "repo", name: "search",
      description: "Search source code in approved repositories.",
      type: "CODE_INTELLIGENCE", risk: "LOW",
      inputSchema: { type: "object", properties: { repositoryId: { type: "string" }, query: { type: "string" } }, required: ["repositoryId", "query"] } },
    { id: IDS.tools.repoRead, ns: "repo", name: "read",
      description: "Read a file from an approved repository.",
      type: "CODE_INTELLIGENCE", risk: "LOW",
      inputSchema: { type: "object", properties: { repositoryId: { type: "string" }, path: { type: "string" } }, required: ["repositoryId", "path"] } },
    { id: IDS.tools.documentRead, ns: "document", name: "read",
      description: "Read a knowledge artifact / document.",
      type: "KNOWLEDGE", risk: "LOW",
      inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] } },
    { id: IDS.tools.deploymentExecute, ns: "deployment", name: "execute",
      description: "Execute a deployment to an environment.",
      type: "DEPLOYMENT", risk: "CRITICAL",
      inputSchema: { type: "object", properties: { environment: { type: "string" } }, required: ["environment"] } },
  ];

  for (const t of tools) {
    const tool = await prisma.toolDefinition.upsert({
      where: { id: t.id }, update: {},
      create: {
        id: t.id, name: t.name, namespace: t.ns,
        description: t.description, toolType: t.type, status: "ACTIVE",
      },
    });
    const existing = await prisma.toolContract.findFirst({ where: { toolId: tool.id } });
    if (!existing) {
      await prisma.toolContract.create({
        data: {
          toolId: tool.id,
          inputSchema: t.inputSchema,
          riskLevel: t.risk,
          requiresApproval: t.risk === "HIGH" || t.risk === "CRITICAL",
          auditRequired: true, timeoutMs: 30000,
          version: 1, status: "ACTIVE",
        },
      });
    }
  }

  console.log("[seed] done — templates:", Object.values(IDS.templates));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

function titleRole(role: string) {
  return role
    .toLowerCase()
    .split("_")
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
