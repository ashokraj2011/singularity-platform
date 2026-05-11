import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

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
    },
  },
  profiles: {
    ARCHITECT:  "00000000-0000-0000-0000-0000000000b1",
    DEVELOPER:  "00000000-0000-0000-0000-0000000000b2",
    QA:         "00000000-0000-0000-0000-0000000000b3",
    GOVERNANCE: "00000000-0000-0000-0000-0000000000b4",
  },
  templates: {
    ARCHITECT:  "00000000-0000-0000-0000-0000000000d1",
    DEVELOPER:  "00000000-0000-0000-0000-0000000000d2",
    QA:         "00000000-0000-0000-0000-0000000000d3",
    GOVERNANCE: "00000000-0000-0000-0000-0000000000d4",
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

  // Platform-wide layers
  const platformConstitution = await prisma.promptLayer.upsert({
    where: { id: IDS.layers.platformConstitution }, update: {},
    create: {
      id: IDS.layers.platformConstitution,
      name: "Platform Constitution",
      layerType: "PLATFORM_CONSTITUTION", scopeType: "PLATFORM",
      content:
        "You operate inside SingularityNeo. Always respect capability boundaries, " +
        "never exfiltrate secrets, prefer evidence over speculation, and produce " +
        "auditable outputs with sources.",
      priority: 10, isRequired: true,
      contentHash: sha("Platform Constitution v1"), status: "ACTIVE",
    },
  });

  const outputContract = await prisma.promptLayer.upsert({
    where: { id: IDS.layers.outputContract }, update: {},
    create: {
      id: IDS.layers.outputContract,
      name: "Default Output Contract",
      layerType: "OUTPUT_CONTRACT", scopeType: "PLATFORM",
      content:
        "Return your output with these sections:\n## Summary\n## Findings\n## Risks\n## Evidence Used",
      priority: 950, isRequired: true,
      contentHash: sha("Default Output Contract v1"), status: "ACTIVE",
    },
  });

  const roleContracts: Array<{ role: "ARCHITECT" | "DEVELOPER" | "QA" | "GOVERNANCE"; name: string; content: string }> = [
    { role: "ARCHITECT", name: "Architect Role Contract", content: "You are an Architect Agent. Analyze design, dependencies, risks, and tradeoffs. Never approve or deploy your own recommendations." },
    { role: "DEVELOPER", name: "Developer Role Contract", content: "You are a Developer Agent. Implement changes safely, write code with tests, prefer small reversible steps." },
    { role: "QA",        name: "QA Role Contract",         content: "You are a QA Agent. Identify regressions, edge cases, performance risks, and missing test coverage." },
    { role: "GOVERNANCE", name: "Governance Role Contract", content: "You are a Governance Agent. Verify approvals, audits, security, and compliance. You can block release." },
  ];

  for (const rc of roleContracts) {
    const layerId = IDS.layers.role[rc.role];
    const layer = await prisma.promptLayer.upsert({
      where: { id: layerId }, update: {},
      create: {
        id: layerId, name: rc.name, layerType: "AGENT_ROLE",
        scopeType: "AGENT_TEMPLATE", content: rc.content,
        priority: 100, isRequired: true,
        contentHash: sha(rc.content), status: "ACTIVE",
      },
    });

    const profileId = IDS.profiles[rc.role];
    const profile = await prisma.promptProfile.upsert({
      where: { id: profileId }, update: {},
      create: {
        id: profileId,
        name: `${rc.role} Base Prompt Profile`,
        description: `Base prompt profile for generic ${rc.role.toLowerCase()} agents.`,
        ownerScopeType: "AGENT_TEMPLATE", status: "ACTIVE",
      },
    });

    for (const [pl, pr] of [[platformConstitution.id, 10], [layer.id, 100], [outputContract.id, 950]] as const) {
      await prisma.promptProfileLayer.upsert({
        where: { promptProfileId_promptLayerId: { promptProfileId: profile.id, promptLayerId: pl } },
        update: { priority: pr, isEnabled: true },
        create: { promptProfileId: profile.id, promptLayerId: pl, priority: pr, isEnabled: true },
      });
    }

    const templateId = IDS.templates[rc.role];
    await prisma.agentTemplate.upsert({
      where: { id: templateId },
      // M23 — re-stamp the lockedReason on every seed run so older databases
      // pick up the governance flag without a manual migration.
      update: { lockedReason: "common platform baseline" },
      create: {
        id: templateId,
        name: `${rc.role.charAt(0)}${rc.role.slice(1).toLowerCase()} Agent`,
        roleType: rc.role, basePromptProfileId: profile.id,
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
