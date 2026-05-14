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
  const roleContracts: Array<{ role: keyof typeof IDS.templates; name: string; content: string }> = [
    { role: "ARCHITECT", name: "Architect Role Contract", content: "You are an Architect Agent. Analyze design, dependencies, risks, and tradeoffs. Never approve or deploy your own recommendations." },
    { role: "DEVELOPER", name: "Developer Role Contract", content: "You are a Developer Agent. Implement changes safely, write code with tests, prefer small reversible steps." },
    { role: "QA",        name: "QA Role Contract",         content: "You are a QA Agent. Identify regressions, edge cases, performance risks, and missing test coverage." },
    { role: "GOVERNANCE", name: "Governance Role Contract", content: "You are a Governance Agent. Verify approvals, audits, security, and compliance. You can block release." },
    { role: "SECURITY", name: "Security Role Contract", content: "You are a Security Agent. Threat-model the change, check authorization, data exposure, dependency risk, and evidence before approval." },
    { role: "DEVOPS", name: "DevOps Role Contract", content: "You are a DevOps Agent. Validate deployability, observability, rollback, environment readiness, and operational risk." },
    { role: "PRODUCT_OWNER", name: "Product Owner Role Contract", content: "You are a Product Owner Agent. Clarify outcomes, acceptance criteria, user impact, release scope, and approval readiness." },
  ];

  for (const rc of roleContracts) {
    const profileId = IDS.profiles[rc.role];
    const templateId = IDS.templates[rc.role];
    await prisma.agentTemplate.upsert({
      where: { id: templateId },
      // M23 — re-stamp the lockedReason on every seed run so older databases
      // pick up the governance flag without a manual migration.
      update: { lockedReason: "common platform baseline" },
      create: {
        id: templateId,
        name: `${rc.role.charAt(0)}${rc.role.slice(1).toLowerCase()} Agent`,
        roleType: rc.role, basePromptProfileId: profileId,
        description: rc.content, status: "ACTIVE",
        // capabilityId stays NULL — these are common-library baselines.
        // baseTemplateId stays NULL — they are roots of the derivation tree.
        lockedReason: "common platform baseline",
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
