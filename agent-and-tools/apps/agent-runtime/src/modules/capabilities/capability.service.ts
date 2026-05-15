import { Prisma } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";
import { ForbiddenError, NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import { extractSymbols, type InputFile } from "./symbol-extractor";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "@agentandtools/shared";
import { summariseSymbol, fileSnippetFor } from "../../lib/llm/summarise";
import { syncIamCapabilityReference } from "./iam-capability-reference";

const BOOTSTRAP_AGENT_CATALOG = [
  {
    key: "product_owner",
    label: "Product Owner",
    roleType: "PRODUCT_OWNER",
    bindingRole: "PRODUCT_OWNER",
    baseRoleType: "PRODUCT_OWNER",
    locked: false,
    activationRequired: false,
    learnsFromGit: true,
    grounding: "Learns story shape, domain terms, acceptance contracts, and release scope from approved repo/docs.",
    description: "Clarifies outcomes, acceptance criteria, user impact, and scope before engineering starts.",
  },
  {
    key: "business_analyst",
    label: "Business Analyst",
    roleType: "BUSINESS_ANALYST",
    bindingRole: "BUSINESS_ANALYST",
    baseRoleType: "PRODUCT_OWNER",
    locked: false,
    activationRequired: false,
    learnsFromGit: true,
    grounding: "Learns domain vocabulary, process rules, validation paths, and edge cases from approved sources.",
    description: "Extracts business rules, constraints, process impact, and open questions.",
  },
  {
    key: "architect",
    label: "Architect",
    roleType: "ARCHITECT",
    bindingRole: "ARCHITECT",
    baseRoleType: "ARCHITECT",
    locked: false,
    activationRequired: false,
    learnsFromGit: true,
    grounding: "Learns architecture, dependency boundaries, modules, and code ownership from approved Git/doc signals.",
    description: "Owns design shape, dependencies, tradeoffs, and implementation plan quality.",
  },
  {
    key: "developer",
    label: "Developer",
    roleType: "DEVELOPER",
    bindingRole: "DEVELOPER",
    baseRoleType: "DEVELOPER",
    locked: false,
    activationRequired: false,
    learnsFromGit: true,
    grounding: "Learns build/run conventions, source layout, component patterns, and local MCP AST/code symbols.",
    description: "Produces implementation tasks, code-change evidence, and handoff notes grounded in the capability codebase.",
  },
  {
    key: "verifier",
    label: "Verifier",
    roleType: "QA",
    bindingRole: "VERIFIER",
    baseRoleType: "QA",
    locked: true,
    activationRequired: true,
    learnsFromGit: true,
    grounding: "Learns test strategy, expected behavior, regression risks, and proof requirements from approved sources.",
    description: "Locked verification gate. Reviews evidence, tests, acceptance criteria, and traceability before completion.",
  },
  {
    key: "qa",
    label: "QA",
    roleType: "QA",
    bindingRole: "QA",
    baseRoleType: "QA",
    locked: false,
    activationRequired: false,
    learnsFromGit: true,
    grounding: "Learns existing test layout, quality signals, and regression coverage from approved source context.",
    description: "Creates QA task packs, regression checks, and release confidence evidence.",
  },
  {
    key: "security",
    label: "Security",
    roleType: "SECURITY",
    bindingRole: "SECURITY",
    baseRoleType: "SECURITY",
    locked: true,
    activationRequired: true,
    learnsFromGit: true,
    grounding: "Learns authentication, data handling, secrets, dependency risk, and threat boundaries from approved sources.",
    description: "Locked security gate. Reviews unsafe tool use, data exposure, authz, dependency risk, and evidence.",
  },
  {
    key: "devops",
    label: "DevOps",
    roleType: "DEVOPS",
    bindingRole: "DEVOPS",
    baseRoleType: "DEVOPS",
    locked: false,
    activationRequired: false,
    learnsFromGit: true,
    grounding: "Learns build, deployment, observability, rollback, and environment readiness from approved runbooks.",
    description: "Owns release readiness, deployability, rollback, and operational evidence.",
  },
  {
    key: "governance",
    label: "Governance",
    roleType: "GOVERNANCE",
    bindingRole: "GOVERNANCE",
    baseRoleType: "GOVERNANCE",
    locked: true,
    activationRequired: true,
    learnsFromGit: false,
    grounding: "Grounded to capability identity, owner team, approvals, budget policy, audit receipts, and required evidence.",
    description: "Locked governance gate. Verifies approvals, budgets, receipts, policy, and promotion readiness.",
  },
] as const;

type BootstrapAgentCatalogItem = (typeof BOOTSTRAP_AGENT_CATALOG)[number];

const DISCOVERY_FILE_CAP = 60;
const DISCOVERY_TOTAL_CHAR_CAP = 500_000;
const DISCOVERY_SOURCE_CHAR_CAP = 40_000;
const LOCAL_BOOTSTRAP_REF = "local://bootstrap-source";
const ENABLE_LLM_SYMBOL_SUMMARIES = (process.env.ENABLE_LLM_SYMBOL_SUMMARIES ?? "0") === "1";

type BootstrapRepositoryInput = {
  repoName?: string;
  repoUrl: string;
  defaultBranch?: string;
  repositoryType?: string;
};

type BootstrapDocumentInput = {
  url: string;
  artifactType?: string;
  title?: string;
  pollIntervalSec?: number | null;
};

type BootstrapInput = {
  name: string;
  appId?: string;
  parentCapabilityId?: string;
  capabilityType?: string;
  businessUnitId?: string;
  ownerTeamId?: string;
  criticality?: string;
  description?: string;
  targetWorkflowPattern?: string;
  agentPreset?: "minimal" | "engineering_core" | "governed_delivery";
  includeAgentKeys?: string[];
  excludeAgentKeys?: string[];
  repositories?: BootstrapRepositoryInput[];
  documentLinks?: BootstrapDocumentInput[];
  localFiles?: InputFile[];
};

type DiscoveryDoc = {
  title: string;
  content: string;
  sourceType: string;
  sourceRef: string;
  path?: string;
};

type CapabilityArchitectureDiagram = {
  kind: "APPLICATION_CAPABILITY_ARCHITECTURE" | "TOGAF_CAPABILITY_COLLECTION";
  title: string;
  view: "application" | "togaf";
  description: string;
  mermaid: string;
  layers: Array<{ key: string; label: string; items: string[] }>;
};

type ReadinessStatus = "READY" | "NEEDS_ATTENTION" | "NOT_READY" | "UNKNOWN";

type ReadinessCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  severity: "blocker" | "warning" | "info";
};

type ReadinessCategory = {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  status: ReadinessStatus;
  summary: string;
  checks: ReadinessCheck[];
};

export const capabilityService = {
  bootstrapAgentCatalog() {
    return {
      presets: [
        { key: "minimal", label: "Minimal governed crew", agents: selectBootstrapAgents({ name: "preview", agentPreset: "minimal" }).map(agent => agent.key) },
        { key: "engineering_core", label: "Engineering core crew", agents: selectBootstrapAgents({ name: "preview", agentPreset: "engineering_core" }).map(agent => agent.key) },
        { key: "governed_delivery", label: "Full governed delivery crew", agents: selectBootstrapAgents({ name: "preview", agentPreset: "governed_delivery" }).map(agent => agent.key) },
      ],
      agents: BOOTSTRAP_AGENT_CATALOG,
    };
  },

  async create(input: {
    name: string; parentCapabilityId?: string; capabilityType?: string;
    appId?: string; businessUnitId?: string; ownerTeamId?: string; criticality?: string; description?: string;
  }, authHeader?: string) {
    const capability = await prisma.capability.create({ data: { ...input, status: "ACTIVE" } });
    const warning = await syncIamCapabilityReference(capability, { authHeader });
    if (warning) console.warn(`[capability] ${warning}`);
    const governanceWarning = await ensureDefaultGovernanceLimits(capability.id);
    if (governanceWarning) console.warn(`[capability] ${governanceWarning}`);
    return capability;
  },

  async bootstrap(input: BootstrapInput, userId?: string, authHeader?: string) {
    const warnings: string[] = [];
    const errors: string[] = [];
    const capability = await prisma.capability.create({
      data: {
        name: input.name,
        appId: input.appId,
        parentCapabilityId: input.parentCapabilityId,
        capabilityType: input.capabilityType,
        businessUnitId: input.businessUnitId,
        ownerTeamId: input.ownerTeamId,
        criticality: input.criticality,
        description: input.description,
        status: "ACTIVE",
      },
    });
    const iamWarning = await syncIamCapabilityReference(capability, {
      authHeader,
      metadata: { bootstrapRunPending: true },
    });
    if (iamWarning) warnings.push(iamWarning);
    const governanceWarning = await ensureDefaultGovernanceLimits(capability.id);
    if (governanceWarning) warnings.push(governanceWarning);

    const run = await prisma.capabilityBootstrapRun.create({
      data: {
        capabilityId: capability.id,
        status: "RUNNING",
        createdBy: userId,
        sourceSummary: {
          repositories: input.repositories?.length ?? 0,
          documentLinks: input.documentLinks?.length ?? 0,
          localFiles: input.localFiles?.length ?? 0,
        },
      },
    });

    const generatedAgents: Array<{
      id: string;
      key: string;
      roleType: string;
      bindingRole: string;
      label: string;
      name: string;
      baseTemplateId?: string | null;
      bindingId?: string;
      locked: boolean;
      activationRequired: boolean;
      learnsFromGit: boolean;
      grounding: string;
    }> = [];
    const discovered: DiscoveryDoc[] = [];

    try {
      const common = await prisma.agentTemplate.findMany({
        where: { capabilityId: null, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });

      const selectedAgents = selectBootstrapAgents(input);
      for (const agent of selectedAgents) {
        const base = common.find(t => t.roleType === agent.baseRoleType);
        if (!base) warnings.push(`No common ${agent.baseRoleType} base template found for ${agent.label}; created a draft placeholder.`);
        const template = await prisma.agentTemplate.create({
          data: {
            name: `${capability.name} ${agent.label} Agent`,
            roleType: agent.roleType,
            description: capabilityAgentDescription(capability.name, agent, base?.description),
            basePromptProfileId: base?.basePromptProfileId ?? undefined,
            defaultToolPolicyId: base?.defaultToolPolicyId ?? undefined,
            capabilityId: capability.id,
            baseTemplateId: base?.id ?? undefined,
            lockedReason: agent.locked ? `${agent.label} is a locked capability gate derived from the platform baseline.` : null,
            status: "DRAFT",
            createdBy: userId,
          },
        });
        const binding = await prisma.agentCapabilityBinding.create({
          data: {
            capabilityId: capability.id,
            agentTemplateId: template.id,
            bindingName: `${agent.label} binding`,
            roleInCapability: agent.bindingRole,
            status: "DRAFT",
            createdBy: userId,
          },
        });
        generatedAgents.push({
          id: template.id,
          key: agent.key,
          roleType: agent.roleType,
          bindingRole: agent.bindingRole,
          label: agent.label,
          name: template.name,
          baseTemplateId: base?.id,
          bindingId: binding.id,
          locked: agent.locked,
          activationRequired: agent.activationRequired,
          learnsFromGit: agent.learnsFromGit,
          grounding: agent.grounding,
        });
      }

      for (const repoInput of input.repositories ?? []) {
        const repoName = repoInput.repoName?.trim() || repoNameFromUrl(repoInput.repoUrl);
        const repo = await prisma.capabilityRepository.create({
          data: {
            capabilityId: capability.id,
            repoName,
            repoUrl: repoInput.repoUrl,
            defaultBranch: repoInput.defaultBranch ?? "main",
            repositoryType: repoInput.repositoryType ?? "GITHUB",
            pollIntervalSec: null,
            status: "ACTIVE",
          },
        });
        try {
          discovered.push(...await discoverGitHubRepo(repo.repoUrl, repo.defaultBranch ?? "main"));
        } catch (err) {
          warnings.push(`Repository discovery skipped for ${repo.repoName}: ${(err as Error).message}`);
        }
      }

      for (const doc of input.documentLinks ?? []) {
        await prisma.capabilityKnowledgeSource.create({
          data: {
            capabilityId: capability.id,
            url: doc.url,
            artifactType: doc.artifactType ?? "DOC",
            title: doc.title,
            pollIntervalSec: null,
            status: "ACTIVE",
          },
        });
        try {
          discovered.push(await fetchDocumentLink(doc));
        } catch (err) {
          warnings.push(`Document discovery skipped for ${doc.url}: ${(err as Error).message}`);
        }
      }

      if ((input.localFiles ?? []).length > 0) {
        await prisma.capabilityRepository.create({
          data: {
            capabilityId: capability.id,
            repoName: "Local bootstrap source",
            repoUrl: LOCAL_BOOTSTRAP_REF,
            defaultBranch: "local",
            repositoryType: "LOCAL",
            pollIntervalSec: null,
            status: "ACTIVE",
          },
        });
        discovered.push(...discoverLocalSignals(input.localFiles ?? []));
      }

      const architectureDiagram = buildCapabilityArchitectureDiagram(capability, input, generatedAgents, discovered);
      const candidates = [
        buildArchitectureDiagramCandidate(capability.name, architectureDiagram),
        ...buildLearningCandidates(discovered),
        ...buildAgentGroundingCandidates(capability.name, selectedAgents, discovered),
      ];
      for (const candidate of candidates) {
        await prisma.capabilityLearningCandidate.create({
          data: {
            capabilityId: capability.id,
            bootstrapRunId: run.id,
            groupKey: candidate.groupKey,
            groupTitle: candidate.groupTitle,
            artifactType: candidate.artifactType,
            title: candidate.title,
            content: candidate.content,
            sourceType: candidate.sourceType,
            sourceRef: candidate.sourceRef,
            confidence: candidate.confidence,
            status: "PENDING",
          },
        });
      }

      return prisma.capabilityBootstrapRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          generatedAgentIds: generatedAgents as unknown as Prisma.InputJsonValue,
          warnings,
          errors,
          sourceSummary: {
            repositories: input.repositories?.length ?? 0,
            documentLinks: input.documentLinks?.length ?? 0,
            localFiles: input.localFiles?.length ?? 0,
            discoveredSignals: discovered.length,
            candidateGroups: candidates.length,
            agentPreset: input.agentPreset ?? "governed_delivery",
            operatingModel: buildOperatingModel(capability, input.targetWorkflowPattern, generatedAgents, candidates.length, architectureDiagram),
          },
        },
        include: { candidates: true, capability: { include: { bindings: { include: { agentTemplate: true } }, repositories: true, knowledgeSources: true } } },
      });
    } catch (err) {
      errors.push((err as Error).message);
      await prisma.capabilityBootstrapRun.update({
        where: { id: run.id },
        data: { status: "FAILED", completedAt: new Date(), generatedAgentIds: generatedAgents as unknown as Prisma.InputJsonValue, warnings, errors },
      });
      throw err;
    }
  },

  async getBootstrapRun(capabilityId: string, runId: string) {
    const run = await prisma.capabilityBootstrapRun.findUnique({
      where: { id: runId },
      include: { candidates: { orderBy: [{ groupKey: "asc" }, { createdAt: "asc" }] }, capability: { include: { bindings: { include: { agentTemplate: true } }, repositories: true, knowledgeSources: true } } },
    });
    if (!run || run.capabilityId !== capabilityId) throw new NotFoundError("Capability bootstrap run not found");
    return run;
  },

  async reviewBootstrapRun(capabilityId: string, runId: string, input: {
    approveGroupKeys: string[]; rejectGroupKeys: string[]; activateAgentTemplateIds: string[];
  }, userId?: string) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const run = await this.getBootstrapRun(capabilityId, runId);
    const approve = new Set(input.approveGroupKeys);
    const reject = new Set(input.rejectGroupKeys);
    const approvedCandidates = run.candidates.filter(c => c.status === "PENDING" && approve.has(c.groupKey));
    const rejectedIds = run.candidates.filter(c => c.status === "PENDING" && reject.has(c.groupKey)).map(c => c.id);

    for (const candidate of approvedCandidates) {
      const artifact = await this.addKnowledge(capabilityId, {
        artifactType: candidate.artifactType,
        title: candidate.title,
        content: candidate.content,
        sourceType: `BOOTSTRAP_${candidate.sourceType ?? "DISCOVERY"}`,
        sourceRef: candidate.sourceRef ?? undefined,
        confidence: candidate.confidence ? Number(candidate.confidence) : 0.8,
      });
      await prisma.capabilityLearningCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "MATERIALIZED",
          materializedArtifactId: artifact.id,
          reviewedBy: userId,
          reviewedAt: new Date(),
        },
      });
    }

    if (rejectedIds.length > 0) {
      await prisma.capabilityLearningCandidate.updateMany({
        where: { id: { in: rejectedIds } },
        data: { status: "REJECTED", reviewedBy: userId, reviewedAt: new Date() },
      });
    }

    const generatedAgentSnapshot = Array.isArray(run.generatedAgentIds)
      ? (run.generatedAgentIds as unknown[])
      : [];
    const generatedAgents = generatedAgentSnapshot.filter((agent): agent is Record<string, unknown> =>
      Boolean(agent && typeof agent === "object" && !Array.isArray(agent)),
    );
    const requiredActivationIds = generatedAgents
      .filter(agent => agent.activationRequired === true && typeof agent.id === "string")
      .map(agent => agent.id as string);
    const activateAgentTemplateIds = Array.from(new Set([...input.activateAgentTemplateIds, ...requiredActivationIds]));

    if (activateAgentTemplateIds.length > 0) {
      await prisma.agentTemplate.updateMany({
        where: { capabilityId, id: { in: activateAgentTemplateIds } },
        data: { status: "ACTIVE" },
      });
      await prisma.agentCapabilityBinding.updateMany({
        where: { capabilityId, agentTemplateId: { in: activateAgentTemplateIds } },
        data: { status: "ACTIVE" },
      });
    }

    const pending = await prisma.capabilityLearningCandidate.count({ where: { bootstrapRunId: runId, status: "PENDING" } });
    await prisma.capabilityBootstrapRun.update({
      where: { id: runId },
      data: { status: pending === 0 ? "REVIEWED" : "COMPLETED", reviewedAt: pending === 0 ? new Date() : undefined },
    });
    return this.getBootstrapRun(capabilityId, runId);
  },

  async syncCapability(capabilityId: string, input: {
    repositoryIds?: string[]; knowledgeSourceIds?: string[]; localFiles?: InputFile[];
  }, helpers: {
    syncRepository: (capabilityId: string, repoId: string) => Promise<unknown>;
    syncKnowledgeSource: (capabilityId: string, sourceId: string) => Promise<unknown>;
  }) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const approved = await prisma.capabilityLearningCandidate.findMany({
      where: { capabilityId, status: "MATERIALIZED" },
      select: { sourceRef: true, sourceType: true },
    });
    if (approved.length === 0) {
      return { repositories: [], knowledgeSources: [], local: null, warnings: ["No approved bootstrap learning exists yet; approve the bootstrap packet before syncing."] };
    }

    const warnings: string[] = [];
    const repositories = [];
    for (const repoId of input.repositoryIds ?? []) {
      const repo = await prisma.capabilityRepository.findUnique({ where: { id: repoId } });
      if (!repo || repo.capabilityId !== capabilityId) {
        warnings.push(`Repository ${repoId} not found for capability.`);
        continue;
      }
      if (!isApprovedSource(approved, repo.repoUrl)) {
        warnings.push(`Repository ${repo.repoName} is not approved for runtime learning yet.`);
        continue;
      }
      repositories.push({ repoId, result: await helpers.syncRepository(capabilityId, repoId) });
    }

    const knowledgeSources = [];
    for (const sourceId of input.knowledgeSourceIds ?? []) {
      const source = await prisma.capabilityKnowledgeSource.findUnique({ where: { id: sourceId } });
      if (!source || source.capabilityId !== capabilityId) {
        warnings.push(`Knowledge source ${sourceId} not found for capability.`);
        continue;
      }
      if (!isApprovedSource(approved, source.url)) {
        warnings.push(`Knowledge source ${source.url} is not approved for runtime learning yet.`);
        continue;
      }
      knowledgeSources.push({ sourceId, result: await helpers.syncKnowledgeSource(capabilityId, sourceId) });
    }

    let local: unknown = null;
    if ((input.localFiles ?? []).length > 0) {
      if (!approved.some(item => item.sourceRef?.includes(LOCAL_BOOTSTRAP_REF) || item.sourceType === "LOCAL_FILE")) {
        warnings.push("Local source is not approved for runtime learning yet.");
      } else {
        const localRepo = await prisma.capabilityRepository.findFirst({
          where: { capabilityId, repositoryType: "LOCAL", status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        });
        if (!localRepo) warnings.push("No local bootstrap repository record exists.");
        else local = await this.extractRepositorySymbols(capabilityId, localRepo.id, input.localFiles ?? []);
      }
    }

    return { repositories, knowledgeSources, local, warnings };
  },

  async runLearningWorker(capabilityId: string, input: {
    approveGroupKeys?: string[];
    rejectGroupKeys?: string[];
    activateAgentTemplateIds?: string[];
    syncApprovedSources?: boolean;
    reembed?: boolean;
    reembedKinds?: ("knowledge" | "memory" | "code")[];
    dryRun?: boolean;
  }, helpers: {
    syncRepository: (capabilityId: string, repoId: string) => Promise<unknown>;
    syncKnowledgeSource: (capabilityId: string, sourceId: string) => Promise<unknown>;
  }, userId?: string) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const dryRun = input.dryRun === true;
    const warnings: string[] = [];
    const nextActions: string[] = [];
    const before = await learningWorkerSnapshot(capabilityId);

    const latestRun = await prisma.capabilityBootstrapRun.findFirst({
      where: { capabilityId },
      orderBy: { createdAt: "desc" },
      include: { candidates: { orderBy: [{ groupKey: "asc" }, { createdAt: "asc" }] } },
    });

    const approveGroupKeys = input.approveGroupKeys ?? [];
    const rejectGroupKeys = input.rejectGroupKeys ?? [];
    const activateAgentTemplateIds = input.activateAgentTemplateIds ?? [];
    let review: unknown = null;
    if (latestRun && (approveGroupKeys.length > 0 || rejectGroupKeys.length > 0 || activateAgentTemplateIds.length > 0)) {
      if (dryRun) {
        review = {
          dryRun: true,
          bootstrapRunId: latestRun.id,
          approveGroupKeys,
          rejectGroupKeys,
          activateAgentTemplateIds,
        };
      } else {
        review = await this.reviewBootstrapRun(capabilityId, latestRun.id, {
          approveGroupKeys,
          rejectGroupKeys,
          activateAgentTemplateIds,
        }, userId);
      }
    }

    if (latestRun && before.learning.pending > 0 && approveGroupKeys.length === 0 && rejectGroupKeys.length === 0) {
      warnings.push(`${before.learning.pending} bootstrap learning candidate(s) are still pending human review.`);
      nextActions.push("Review pending bootstrap learning groups, then rerun the worker to materialize approved knowledge.");
    }

    let sync: unknown = null;
    if (input.syncApprovedSources !== false) {
      const [repositories, knowledgeSources] = await Promise.all([
        prisma.capabilityRepository.findMany({ where: { capabilityId, status: "ACTIVE" }, select: { id: true } }),
        prisma.capabilityKnowledgeSource.findMany({ where: { capabilityId, status: "ACTIVE" }, select: { id: true } }),
      ]);
      if (dryRun) {
        sync = {
          dryRun: true,
          repositoryIds: repositories.map(repo => repo.id),
          knowledgeSourceIds: knowledgeSources.map(source => source.id),
        };
      } else {
        try {
          sync = await this.syncCapability(capabilityId, {
            repositoryIds: repositories.map(repo => repo.id),
            knowledgeSourceIds: knowledgeSources.map(source => source.id),
          }, helpers);
        } catch (err) {
          const message = `Approved source sync failed: ${(err as Error).message}`;
          warnings.push(message);
          sync = { error: message };
        }
      }
    }

    if (sync && typeof sync === "object" && !Array.isArray(sync)) {
      const syncWarnings = (sync as { warnings?: unknown }).warnings;
      if (Array.isArray(syncWarnings)) warnings.push(...syncWarnings.map(String));
    }

    let reembed: unknown = null;
    if (input.reembed !== false) {
      const kinds = input.reembedKinds ?? ["knowledge", "memory", "code"];
      if (dryRun) reembed = { dryRun: true, kinds };
      else reembed = await this.reembedCapability(capabilityId, { kinds });
    }

    const after = dryRun ? before : await learningWorkerSnapshot(capabilityId);
    if (after.learning.materialized === 0) {
      nextActions.push("Approve at least one learning group so repo/doc sync can promote grounded knowledge.");
    }
    if (after.knowledge.active === 0) {
      nextActions.push("Materialize bootstrap candidates or upload knowledge artifacts before running governed workflows.");
    }
    if (after.repositories.active > 0 && after.codeSymbols.total === 0) {
      nextActions.push("Use MCP local AST indexing for private code, or enable POLL_REPOSITORIES_ENABLED and EXTRACTOR_MODE for central code-symbol mirroring.");
    }

    return {
      capabilityId,
      ranAt: new Date().toISOString(),
      dryRun,
      latestBootstrapRunId: latestRun?.id ?? null,
      before,
      review,
      sync,
      reembed,
      after,
      warnings: Array.from(new Set(warnings)),
      nextActions: Array.from(new Set(nextActions)),
      capsuleInvalidation: "No direct purge required. Prompt Composer task signatures include capability content timestamps/counts, so newly materialized artifacts and memory make old capsules unreachable.",
    };
  },

  async list() {
    return prisma.capability.findMany({
      orderBy: { createdAt: "desc" },
      include: { children: true, repositories: true },
    });
  },

  async get(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        children: true,
        parent: true,
        repositories: true,
        knowledgeArtifacts: { orderBy: { createdAt: "desc" } },
        bindings: { include: { agentTemplate: true } },
        bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 5 },
        learningCandidates: { orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");
    return cap;
  },

  async readiness(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        repositories: true,
        knowledgeArtifacts: true,
        knowledgeSources: true,
        bindings: { include: { agentTemplate: true } },
        bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 3 },
        learningCandidates: { orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");

    const activeBindings = cap.bindings.filter(binding =>
      String(binding.status) === "ACTIVE" && String(binding.agentTemplate?.status ?? "") === "ACTIVE",
    );
    const allBindings = cap.bindings.filter(binding => String(binding.status) !== "ARCHIVED");
    const activeRepos = cap.repositories.filter(repo => String(repo.status) === "ACTIVE");
    const activeKnowledge = cap.knowledgeArtifacts.filter(artifact => String(artifact.status) === "ACTIVE");
    const activeSources = cap.knowledgeSources.filter(source => String(source.status) === "ACTIVE");
    const latestBootstrap = cap.bootstrapRuns[0];
    const materializedLearning = cap.learningCandidates.filter(candidate => candidate.status === "MATERIALIZED");
    const pendingLearning = cap.learningCandidates.filter(candidate => candidate.status === "PENDING");
    const codeSymbols = await prisma.capabilityCodeSymbol.count({ where: { capabilityId: id } });
    const lockedRoles = new Set(
      allBindings
        .filter(binding => Boolean(binding.agentTemplate?.lockedReason))
        .map(binding => String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "").toUpperCase()),
    );
    const activeRoles = new Set(activeBindings.map(binding =>
      String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "").toUpperCase(),
    ));

    const category = (
      key: string,
      label: string,
      maxScore: number,
      checks: ReadinessCheck[],
      summary: string,
      forcedStatus?: ReadinessStatus,
    ): ReadinessCategory => {
      const passed = checks.filter(check => check.ok).length;
      const score = checks.length === 0 ? 0 : Math.round((passed / checks.length) * maxScore);
      const hasBlocker = checks.some(check => !check.ok && check.severity === "blocker");
      const hasWarning = checks.some(check => !check.ok && check.severity === "warning");
      const percent = maxScore > 0 ? score / maxScore : 0;
      const status: ReadinessStatus = forcedStatus ?? (hasBlocker ? "NOT_READY" : hasWarning || percent < 0.85 ? "NEEDS_ATTENTION" : "READY");
      return { key, label, score, maxScore, status, summary, checks };
    };

    const categories = [
      category("identity_governance", "Identity & governance", 20, [
        {
          key: "active",
          label: "Capability is active",
          ok: String(cap.status) === "ACTIVE",
          detail: `Current status is ${String(cap.status)}.`,
          severity: "blocker",
        },
        {
          key: "owner_team",
          label: "Owner team is set",
          ok: Boolean(cap.ownerTeamId),
          detail: cap.ownerTeamId ? `Owner team ${cap.ownerTeamId}.` : "No IAM owner team is recorded.",
          severity: "blocker",
        },
        {
          key: "business_unit",
          label: "Business unit is set",
          ok: Boolean(cap.businessUnitId),
          detail: cap.businessUnitId ? `Business unit ${cap.businessUnitId}.` : "No business unit is recorded.",
          severity: "warning",
        },
        {
          key: "criticality",
          label: "Criticality is set",
          ok: Boolean(cap.criticality),
          detail: cap.criticality ? `Criticality ${cap.criticality}.` : "No criticality is recorded.",
          severity: "warning",
        },
      ], "Capability identity has enough metadata for ownership and governance routing."),
      category("agent_team", "Agent team", 25, [
        {
          key: "active_agents",
          label: "Capability agents are active",
          ok: activeBindings.length >= 3,
          detail: `${activeBindings.length} active agent binding(s).`,
          severity: "blocker",
        },
        {
          key: "governance_gate",
          label: "Locked governance gate exists",
          ok: lockedRoles.has("GOVERNANCE"),
          detail: lockedRoles.has("GOVERNANCE") ? "Governance agent is locked." : "No locked Governance agent binding found.",
          severity: "blocker",
        },
        {
          key: "verifier_gate",
          label: "Locked verifier gate exists",
          ok: lockedRoles.has("VERIFIER") || lockedRoles.has("QA"),
          detail: lockedRoles.has("VERIFIER") || lockedRoles.has("QA") ? "Verifier/QA gate is locked." : "No locked Verifier/QA gate found.",
          severity: "warning",
        },
        {
          key: "prompt_bindings",
          label: "Prompt bindings exist",
          ok: activeBindings.some(binding => Boolean(binding.promptProfileId ?? binding.agentTemplate?.basePromptProfileId)),
          detail: `${activeBindings.filter(binding => Boolean(binding.promptProfileId ?? binding.agentTemplate?.basePromptProfileId)).length} agent(s) have prompt profile references.`,
          severity: "warning",
        },
        {
          key: "core_roles",
          label: "Core delivery roles exist",
          ok: ["PRODUCT_OWNER", "ARCHITECT", "DEVELOPER"].every(role => activeRoles.has(role)),
          detail: `Active roles: ${Array.from(activeRoles).sort().join(", ") || "none"}.`,
          severity: "warning",
        },
      ], "Activated agents, prompt bindings, and locked gates are ready for governed delivery."),
      category("knowledge_code", "Knowledge & code grounding", 20, [
        {
          key: "repository",
          label: "Repository/source configured",
          ok: activeRepos.length > 0 || activeSources.length > 0,
          detail: `${activeRepos.length} active repo(s), ${activeSources.length} active knowledge source(s).`,
          severity: "warning",
        },
        {
          key: "knowledge_artifacts",
          label: "Knowledge artifacts materialized",
          ok: activeKnowledge.length > 0,
          detail: `${activeKnowledge.length} active knowledge artifact(s).`,
          severity: "warning",
        },
        {
          key: "learning_review",
          label: "Learning review is not stuck",
          ok: pendingLearning.length === 0 || materializedLearning.length > 0,
          detail: `${pendingLearning.length} pending learning candidate(s), ${materializedLearning.length} materialized.`,
          severity: "warning",
        },
        {
          key: "code_symbols",
          label: "Code symbols or MCP AST available",
          ok: codeSymbols > 0 || activeRepos.length > 0,
          detail: codeSymbols > 0 ? `${codeSymbols} central code symbol(s).` : "Central symbols absent; MCP local AST can supply private code context.",
          severity: "info",
        },
      ], "Knowledge, source, and learning signals exist for grounded context."),
      category("workflow_readiness", "Workflow readiness", 20, [
        {
          key: "bootstrap_completed",
          label: "Bootstrap produced an operating model",
          ok: Boolean(latestBootstrap && ["COMPLETED", "REVIEWED"].includes(latestBootstrap.status)),
          detail: latestBootstrap ? `Latest bootstrap status ${latestBootstrap.status}.` : "No bootstrap run found.",
          severity: "warning",
        },
        {
          key: "bootstrap_reviewed",
          label: "Bootstrap review completed",
          ok: Boolean(latestBootstrap?.reviewedAt),
          detail: latestBootstrap?.reviewedAt ? `Reviewed ${latestBootstrap.reviewedAt.toISOString()}.` : "Bootstrap packet has not been fully reviewed.",
          severity: "warning",
        },
      ], "Agent-runtime can confirm bootstrap intent; Workgraph confirms actual workflows and budgets in Operations."),
      category("runtime_readiness", "Runtime readiness", 15, [
        {
          key: "mcp_endpoint",
          label: "MCP invoke endpoint configured",
          ok: Boolean(process.env.MCP_INVOKE_URL),
          detail: process.env.MCP_INVOKE_URL ? `MCP invoke URL configured.` : "MCP invoke URL is not set in agent-runtime.",
          severity: "info",
        },
        {
          // M33 — embeddings flow through the central LLM gateway. The
          // health check just verifies LLM_GATEWAY_URL is set; provider
          // credential presence is enforced by the gateway itself.
          key: "embedding_provider",
          label: "LLM gateway configured for embeddings",
          ok: Boolean(process.env.LLM_GATEWAY_URL),
          detail: `Embedding dim target is ${REQUIRED_EMBEDDING_DIM}; routed via LLM_GATEWAY_URL.`,
          severity: "info",
        },
      ], "Runtime endpoint checks are local configuration hints; full health is shown in Operations.", "UNKNOWN"),
    ];

    const blockers = categories.flatMap(cat => cat.checks
      .filter(check => !check.ok && check.severity === "blocker")
      .map(check => ({ category: cat.key, key: check.key, message: check.detail })));
    const warnings = categories.flatMap(cat => cat.checks
      .filter(check => !check.ok && check.severity !== "blocker")
      .map(check => ({ category: cat.key, key: check.key, message: check.detail, severity: check.severity })));
    const maxScore = categories.reduce((sum, cat) => sum + cat.maxScore, 0);
    const score = Math.round(categories.reduce((sum, cat) => sum + cat.score, 0) / Math.max(maxScore, 1) * 100);
    const status: ReadinessStatus = blockers.length > 0
      ? "NOT_READY"
      : score >= 85 && warnings.length === 0
          ? "READY"
          : score >= 60
            ? "NEEDS_ATTENTION"
            : "NOT_READY";
    const recommendedActions = [
      ...blockers.map(blocker => blocker.message),
      ...warnings.slice(0, 5).map(warning => warning.message),
    ];

    return {
      capabilityId: cap.id,
      generatedAt: new Date().toISOString(),
      score,
      status,
      categories,
      blockers,
      warnings,
      recommendedActions,
      facts: {
        activeAgents: activeBindings.length,
        repositories: activeRepos.length,
        knowledgeSources: activeSources.length,
        knowledgeArtifacts: activeKnowledge.length,
        pendingLearningCandidates: pendingLearning.length,
        materializedLearningCandidates: materializedLearning.length,
        codeSymbols,
        latestBootstrapStatus: latestBootstrap?.status ?? null,
      },
    };
  },

  async architectureDiagram(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        repositories: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
        knowledgeSources: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
        bindings: { where: { status: "ACTIVE" }, include: { agentTemplate: true }, orderBy: { createdAt: "asc" } },
        bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");

    const bootstrap = cap.bootstrapRuns[0];
    const summary = jsonRecord(bootstrap?.sourceSummary);
    const operatingModel = jsonRecord(summary.operatingModel);
    const stored = normalizeArchitectureDiagram(operatingModel.architectureDiagram);
    if (stored) {
      return {
        capabilityId: cap.id,
        generatedAt: (bootstrap.completedAt ?? bootstrap.updatedAt ?? bootstrap.createdAt).toISOString(),
        source: "bootstrap",
        ...stored,
      };
    }

    const input: BootstrapInput = {
      name: cap.name,
      appId: cap.appId ?? undefined,
      parentCapabilityId: cap.parentCapabilityId ?? undefined,
      capabilityType: cap.capabilityType ?? undefined,
      businessUnitId: cap.businessUnitId ?? undefined,
      ownerTeamId: cap.ownerTeamId ?? undefined,
      criticality: cap.criticality ?? undefined,
      description: cap.description ?? undefined,
      repositories: cap.repositories.map(repo => ({
        repoName: repo.repoName,
        repoUrl: repo.repoUrl,
        defaultBranch: repo.defaultBranch ?? undefined,
        repositoryType: repo.repositoryType ?? undefined,
      })),
      documentLinks: cap.knowledgeSources.map(source => ({
        url: source.url,
        artifactType: source.artifactType,
        title: source.title ?? undefined,
        pollIntervalSec: source.pollIntervalSec ?? undefined,
      })),
    };
    const generatedAgents = cap.bindings.map(binding => ({
      label: binding.agentTemplate?.name ?? binding.bindingName,
      roleType: String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "AGENT"),
      locked: Boolean(binding.agentTemplate?.lockedReason),
      learnsFromGit: true,
    }));
    const docs: DiscoveryDoc[] = cap.knowledgeSources.map(source => ({
      title: source.title ?? source.url,
      content: source.url,
      sourceType: "DOCUMENT_LINK",
      sourceRef: source.url,
    }));
    const diagram = buildCapabilityArchitectureDiagram(cap, input, generatedAgents, docs);
    return {
      capabilityId: cap.id,
      generatedAt: new Date().toISOString(),
      source: "live",
      ...diagram,
    };
  },

  async update(id: string, input: {
    name?: string;
    appId?: string | null;
    parentCapabilityId?: string | null;
    capabilityType?: string | null;
    businessUnitId?: string | null;
    ownerTeamId?: string | null;
    criticality?: string | null;
    description?: string | null;
  }, authHeader?: string) {
    const existing = await prisma.capability.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Capability not found");
    assertCapabilityNotArchived(existing);

    const data: Prisma.CapabilityUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.appId !== undefined) data.appId = input.appId;
    if (input.parentCapabilityId !== undefined) {
      data.parent = input.parentCapabilityId
        ? { connect: { id: input.parentCapabilityId } }
        : { disconnect: true };
    }
    if (input.capabilityType !== undefined) data.capabilityType = input.capabilityType;
    if (input.businessUnitId !== undefined) data.businessUnitId = input.businessUnitId;
    if (input.ownerTeamId !== undefined) data.ownerTeamId = input.ownerTeamId;
    if (input.criticality !== undefined) data.criticality = input.criticality;
    if (input.description !== undefined) data.description = input.description;

    const updated = await prisma.capability.update({ where: { id }, data });
    const warning = await syncIamCapabilityReference(updated, { authHeader });
    if (warning) console.warn(`[capability] ${warning}`);
    return this.get(id);
  },

  async archive(id: string, userId?: string, authHeader?: string) {
    const existing = await prisma.capability.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Capability not found");

    const result = await prisma.$transaction(async (tx) => {
      const archived = await tx.capability.update({
        where: { id },
        data: { status: "ARCHIVED" },
      });

      await tx.agentCapabilityBinding.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "INACTIVE" },
      });
      await tx.agentTemplate.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED" },
      });
      await tx.capabilityRepository.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED", pollIntervalSec: null },
      });
      await tx.capabilityKnowledgeSource.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED", pollIntervalSec: null },
      });
      await tx.capabilityKnowledgeArtifact.updateMany({
        where: { capabilityId: id, status: "ACTIVE" },
        data: { status: "ARCHIVED" },
      });
      await tx.capabilityLearningCandidate.updateMany({
        where: { capabilityId: id, status: "PENDING" },
        data: { status: "REJECTED", reviewedBy: userId, reviewedAt: new Date() },
      });

      return {
        capability: archived,
        archived: true,
      };
    });
    const warning = await syncIamCapabilityReference(result.capability, { authHeader });
    if (warning) console.warn(`[capability] ${warning}`);
    return result;
  },

  async attachRepository(capabilityId: string, input: {
    repoName: string; repoUrl: string; defaultBranch: string; repositoryType: string;
  }) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    return prisma.capabilityRepository.create({
      data: { ...input, capabilityId, status: "ACTIVE" },
    });
  },

  async bindAgent(capabilityId: string, input: {
    agentTemplateId: string; bindingName: string;
    roleInCapability?: string; promptProfileId?: string;
    toolPolicyId?: string; memoryScopePolicyId?: string;
  }, userId?: string) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");
    return prisma.agentCapabilityBinding.create({
      data: { ...input, roleInCapability: input.roleInCapability ?? template.roleType, capabilityId, createdBy: userId, status: "ACTIVE" },
    });
  },

  async listBindings(capabilityId: string) {
    return prisma.agentCapabilityBinding.findMany({
      where: { capabilityId },
      include: { agentTemplate: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async addKnowledge(capabilityId: string, input: {
    artifactType: string; title: string; content: string;
    sourceType?: string; sourceRef?: string; confidence?: number;
  }) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const contentHash = sha256(input.content);
    const created = await prisma.capabilityKnowledgeArtifact.create({
      data: {
        capabilityId,
        artifactType: input.artifactType,
        title: input.title,
        content: input.content,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        confidence: input.confidence,
        contentHash,
        status: "ACTIVE",
      },
    });

    // M15 — embed-on-write. Failure logs and continues; the row still lands
    // and the composer simply won't pick it up via semantic search until a
    // backfill/re-upload. Prisma can't bind `vector(N)`, so we use raw SQL.
    try {
      const reused = await prisma.$executeRawUnsafe(
        `UPDATE "CapabilityKnowledgeArtifact" target
         SET embedding = source.embedding
         FROM (
           SELECT embedding FROM "CapabilityKnowledgeArtifact"
           WHERE "contentHash" = $1 AND id <> $2 AND embedding IS NOT NULL
           ORDER BY "createdAt" DESC
           LIMIT 1
         ) source
         WHERE target.id = $2`,
        contentHash,
        created.id,
      );
      if (reused > 0) return created;
      const embedder = getEmbeddingProvider();
      const embedTarget = `${input.title}\n${input.content}`.slice(0, 8_000);
      const embedded = await embedder.embed({ text: embedTarget });
      assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
      await prisma.$executeRawUnsafe(
        `UPDATE "CapabilityKnowledgeArtifact" SET embedding = $1::vector WHERE id = $2`,
        toVectorLiteral(embedded.vector),
        created.id,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[knowledge] embedding failed for ${created.id}: ${(err as Error).message}`);
    }
    return created;
  },

  async listKnowledge(capabilityId: string) {
    return prisma.capabilityKnowledgeArtifact.findMany({
      where: { capabilityId },
      orderBy: { createdAt: "desc" },
    });
  },

  // M14 — repository symbol extraction. Idempotent on `(repositoryId,
  // symbolHash)` so re-running an extract over the same files won't create
  // duplicates. Embeds each new symbol via the configured provider; failures
  // don't abort the whole run — the symbol row still lands so a follow-up
  // can re-embed.
  async extractRepositorySymbols(capabilityId: string, repositoryId: string, files: InputFile[]) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const repo = await prisma.capabilityRepository.findUnique({ where: { id: repositoryId } });
    if (!repo || repo.capabilityId !== capabilityId) {
      throw new NotFoundError("Repository not found for this capability");
    }
    // M25.7 #4 — CapabilityCodeSymbol / CapabilityCodeEmbedding are
    // superseded by mcp-server's local AST index (lives wherever
    // mcp-server runs — laptop, VPC, dev box). EXTRACTOR_MODE defaults
    // to `off`; when set, extractSymbols() short-circuits to [] and we
    // return early without touching the symbol tables. This keeps
    // existing rows queryable (read-only) without churning new ones.
    await assertCodeExtractionApproved(capabilityId, repo);
    const symbols = await extractSymbols(files);
    if (symbols.length === 0) {
      // Either EXTRACTOR_MODE=off OR the files genuinely produced no
      // symbols. Either way there's nothing to persist; short-circuit
      // before allocating the embedder + maps.
      return {
        inserted: 0,
        skippedDuplicate: 0,
        embeddingErrors: 0,
        llmSummaries: 0,
        parentLinked: 0,
        scannedFiles: files.length,
        extractorMode: process.env.EXTRACTOR_MODE ?? "off",
      };
    }
    const embedder = getEmbeddingProvider();

    // Index files by path so we can pull a snippet for the LLM summariser.
    const fileByPath = new Map(files.map((f) => [f.path, f.content]));

    let inserted = 0;
    let skippedDuplicate = 0;
    let embeddingErrors = 0;
    let llmSummaries = 0;
    let parentLinked = 0;

    // M16 — track each class row by (filePath, symbolName) so methods landing
    // later in the same file can link via parentSymbolId. Pre-load existing
    // class rows for this repo so re-extracts also link correctly.
    const classByKey = new Map<string, string>();
    {
      const existingClasses = await prisma.capabilityCodeSymbol.findMany({
        where: { repositoryId, symbolType: "class" },
        select: { id: true, filePath: true, symbolName: true },
      });
      for (const c of existingClasses) {
        if (c.symbolName) classByKey.set(`${c.filePath}::${c.symbolName}`, c.id);
      }
    }

    for (const s of symbols) {
      const existing = await prisma.capabilityCodeSymbol.findFirst({
        where: { repositoryId, symbolHash: s.symbolHash },
        select: { id: true },
      });
      if (existing) {
        // Symbol already exists. Skip the row write but re-embed if no
        // pgvector embedding lives for it yet — common after migrating M14
        // rows where vectorId was JSON text and `embedding` is null. Prisma
        // can't `select` an Unsupported() column, so count via raw SQL.
        const probe = await prisma.$queryRawUnsafe<Array<{ has: boolean }>>(
          `SELECT EXISTS(
             SELECT 1 FROM "CapabilityCodeEmbedding"
             WHERE "symbolId" = $1 AND embedding IS NOT NULL
           ) AS has`,
          existing.id,
        );
        if (probe[0]?.has) { skippedDuplicate += 1; continue; }
        try {
          const embedTarget = `${s.symbolName}\n${s.summary ?? ""}`.trim();
          const embedded = await embedder.embed({ text: embedTarget });
          assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
          const emb = await prisma.capabilityCodeEmbedding.create({
            data: {
              symbolId: existing.id,
              embeddingModel: `${embedded.provider}:${embedded.model}:${embedded.dim}`,
              vectorId: JSON.stringify(embedded.vector),
              summary: s.summary ?? null,
            },
          });
          await prisma.$executeRawUnsafe(
            `UPDATE "CapabilityCodeEmbedding" SET embedding = $1::vector WHERE id = $2`,
            toVectorLiteral(embedded.vector),
            emb.id,
          );
        } catch (err) {
          embeddingErrors += 1;
          // eslint-disable-next-line no-console
          console.warn(`[symbol-extractor] re-embed failed for ${s.filePath}:${s.symbolName}: ${(err as Error).message}`);
        }
        skippedDuplicate += 1;
        continue;
      }

      // M15 — keep per-symbol LLM calls opt-in. By default we use the
      // extractor/docstring signal plus deterministic summaries so a large
      // repo sync does not create one LLM call per undocumented symbol.
      let summary = s.summary ?? null;
      if (!summary && ENABLE_LLM_SYMBOL_SUMMARIES) {
        const content = fileByPath.get(s.filePath);
        if (content) {
          const generated = await summariseSymbol({
            symbolName: s.symbolName,
            symbolType: s.symbolType,
            language: s.language,
            filePath: s.filePath,
            fileSnippet: fileSnippetFor(content, s.startLine),
          });
          if (generated) {
            summary = generated;
            llmSummaries += 1;
          }
        }
      }
      if (!summary) summary = deterministicSymbolSummary(s);

      // Resolve parentSymbolId for methods to the enclosing class row, when
      // the class was extracted in this batch or persisted from a prior run.
      let parentSymbolId: string | undefined;
      if (s.symbolType === "method" && s.parentClassName) {
        const key = `${s.filePath}::${s.parentClassName}`;
        parentSymbolId = classByKey.get(key);
        if (parentSymbolId) parentLinked += 1;
      }

      const row = await prisma.capabilityCodeSymbol.create({
        data: {
          capabilityId,
          repositoryId,
          filePath: s.filePath,
          language: s.language,
          symbolName: s.symbolName,
          symbolType: s.symbolType,
          parentSymbolId,
          startLine: s.startLine,
          summary,
          symbolHash: s.symbolHash,
        },
      });
      if (s.symbolType === "class") {
        classByKey.set(`${s.filePath}::${s.symbolName}`, row.id);
      }
      inserted += 1;

      try {
        const embedTarget = `${s.symbolName}\n${summary ?? ""}`.trim();
        const embedded = await embedder.embed({ text: embedTarget });
        assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
        // M15 — write the embedding into the pgvector column via raw SQL.
        // Prisma still can't bind `Unsupported("vector(N)")`, so we
        // create the row first and UPDATE the vector second. The `vectorId`
        // column is kept as JSON-string redundancy so we can audit which
        // model produced which vector without a join.
        const emb = await prisma.capabilityCodeEmbedding.create({
          data: {
            symbolId: row.id,
            embeddingModel: `${embedded.provider}:${embedded.model}:${embedded.dim}`,
            vectorId: JSON.stringify(embedded.vector),
            summary,
          },
        });
        await prisma.$executeRawUnsafe(
          `UPDATE "CapabilityCodeEmbedding" SET embedding = $1::vector WHERE id = $2`,
          toVectorLiteral(embedded.vector),
          emb.id,
        );
      } catch (err) {
        embeddingErrors += 1;
        // eslint-disable-next-line no-console
        console.warn(`[symbol-extractor] embedding failed for ${s.filePath}:${s.symbolName}: ${(err as Error).message}`);
      }
    }

    return {
      filesProcessed: files.length,
      symbolsScanned: symbols.length,
      inserted,
      skippedDuplicate,
      embeddingErrors,
      llmSummaries,
      parentLinked,
      provider: embedder.name,
      providerModel: embedder.defaultModel,
      requiredDim: REQUIRED_EMBEDDING_DIM,
    };
  },

  // M17 — polling config + knowledge sources.
  async updateRepositoryPoll(capabilityId: string, repoId: string, input: {
    pollIntervalSec?: number | null; defaultBranch?: string;
  }) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const repo = await prisma.capabilityRepository.findUnique({ where: { id: repoId } });
    if (!repo || repo.capabilityId !== capabilityId) throw new NotFoundError("Repository not found");
    return prisma.capabilityRepository.update({
      where: { id: repoId },
      data: {
        pollIntervalSec: input.pollIntervalSec === undefined ? undefined : input.pollIntervalSec,
        defaultBranch:   input.defaultBranch ?? undefined,
      },
    });
  },

  async listKnowledgeSources(capabilityId: string) {
    return prisma.capabilityKnowledgeSource.findMany({
      where: { capabilityId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  },

  async addKnowledgeSource(capabilityId: string, input: {
    url: string; artifactType?: string; title?: string; pollIntervalSec?: number | null;
  }) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    return prisma.capabilityKnowledgeSource.create({
      data: {
        capabilityId,
        url: input.url,
        artifactType: input.artifactType ?? "DOC",
        title: input.title,
        pollIntervalSec: input.pollIntervalSec ?? 600,
        status: "ACTIVE",
      },
    });
  },

  async updateKnowledgeSource(capabilityId: string, sourceId: string, input: {
    url?: string; artifactType?: string; title?: string; pollIntervalSec?: number | null;
  }) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const src = await prisma.capabilityKnowledgeSource.findUnique({ where: { id: sourceId } });
    if (!src || src.capabilityId !== capabilityId) throw new NotFoundError("Knowledge source not found");
    return prisma.capabilityKnowledgeSource.update({
      where: { id: sourceId },
      data: {
        url:             input.url ?? undefined,
        artifactType:    input.artifactType ?? undefined,
        title:           input.title ?? undefined,
        pollIntervalSec: input.pollIntervalSec === undefined ? undefined : input.pollIntervalSec,
      },
    });
  },

  async deleteKnowledgeSource(capabilityId: string, sourceId: string) {
    assertCapabilityNotArchived(await this.get(capabilityId));
    const src = await prisma.capabilityKnowledgeSource.findUnique({ where: { id: sourceId } });
    if (!src || src.capabilityId !== capabilityId) throw new NotFoundError("Knowledge source not found");
    return prisma.capabilityKnowledgeSource.update({
      where: { id: sourceId }, data: { status: "ARCHIVED" },
    });
  },

  // M16 — re-embed worker. Backfills embeddings for any rows whose vector
  // column is NULL across all three tables for a capability. Used after:
  //   1. Switching providers (eg mock → openai) — old vectors are still
  //      stored but the new model won't find anything until backfilled.
  //   2. Migrating M14 v0 rows whose vectorId is JSON text but `embedding`
  //      is NULL.
  // Scoped to a single capability so a partial-tenant backfill is possible.
  async reembedCapability(capabilityId: string, opts: { kinds?: ("knowledge" | "memory" | "code")[] } = {}) {
    await this.get(capabilityId);
    const embedder = getEmbeddingProvider();
    const kinds = new Set(opts.kinds ?? ["knowledge", "memory", "code"]);

    const out = {
      provider: embedder.name,
      providerModel: embedder.defaultModel,
      knowledge: { scanned: 0, embedded: 0, failed: 0 },
      memory:    { scanned: 0, embedded: 0, failed: 0 },
      code:      { scanned: 0, embedded: 0, failed: 0 },
    };

    if (kinds.has("knowledge")) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; content: string }>>(
        `SELECT id, title, content FROM "CapabilityKnowledgeArtifact"
         WHERE "capabilityId" = $1 AND status = 'ACTIVE' AND embedding IS NULL
         ORDER BY "createdAt" DESC LIMIT 500`,
        capabilityId,
      );
      out.knowledge.scanned = rows.length;
      for (const r of rows) {
        try {
          const emb = await embedder.embed({ text: `${r.title}\n${r.content}`.slice(0, 8_000) });
          assertDimMatches(emb.dim, `${emb.provider}:${emb.model}`);
          await prisma.$executeRawUnsafe(
            `UPDATE "CapabilityKnowledgeArtifact" SET embedding = $1::vector WHERE id = $2`,
            toVectorLiteral(emb.vector), r.id,
          );
          out.knowledge.embedded += 1;
        } catch { out.knowledge.failed += 1; }
      }
    }

    if (kinds.has("memory")) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; content: string }>>(
        `SELECT id, title, content FROM "DistilledMemory"
         WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $1
           AND status = 'ACTIVE' AND embedding IS NULL
         ORDER BY "createdAt" DESC LIMIT 500`,
        capabilityId,
      );
      out.memory.scanned = rows.length;
      for (const r of rows) {
        try {
          const emb = await embedder.embed({ text: `${r.title}\n${r.content}`.slice(0, 8_000) });
          assertDimMatches(emb.dim, `${emb.provider}:${emb.model}`);
          await prisma.$executeRawUnsafe(
            `UPDATE "DistilledMemory" SET embedding = $1::vector WHERE id = $2`,
            toVectorLiteral(emb.vector), r.id,
          );
          out.memory.embedded += 1;
        } catch { out.memory.failed += 1; }
      }
    }

    if (kinds.has("code")) {
      // Two flavours: (a) symbol has no embedding row at all, (b) row exists
      // but `embedding` is NULL (M14 v0 rows). Both mean "no semantic data".
      const rows = await prisma.$queryRawUnsafe<Array<{
        symbol_id: string; symbolName: string; summary: string | null;
        embedding_id: string | null;
      }>>(
        `SELECT s.id AS symbol_id, s."symbolName", s.summary,
                e.id AS embedding_id
         FROM "CapabilityCodeSymbol" s
         LEFT JOIN "CapabilityCodeEmbedding" e ON e."symbolId" = s.id
         WHERE s."capabilityId" = $1
           AND (e.id IS NULL OR e.embedding IS NULL)
         ORDER BY s."createdAt" DESC LIMIT 1000`,
        capabilityId,
      );
      out.code.scanned = rows.length;
      for (const r of rows) {
        try {
          const target = `${r.symbolName ?? ""}\n${r.summary ?? ""}`.trim() || "symbol";
          const emb = await embedder.embed({ text: target });
          assertDimMatches(emb.dim, `${emb.provider}:${emb.model}`);
          let embId = r.embedding_id;
          if (!embId) {
            const created = await prisma.capabilityCodeEmbedding.create({
              data: {
                symbolId: r.symbol_id,
                embeddingModel: `${emb.provider}:${emb.model}:${emb.dim}`,
                vectorId: JSON.stringify(emb.vector),
                summary: r.summary,
              },
            });
            embId = created.id;
          }
          await prisma.$executeRawUnsafe(
            `UPDATE "CapabilityCodeEmbedding" SET embedding = $1::vector WHERE id = $2`,
            toVectorLiteral(emb.vector), embId,
          );
          out.code.embedded += 1;
        } catch { out.code.failed += 1; }
      }
    }

    return out;
  },
};

function repoNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || parsed.hostname;
  } catch {
    return url.slice(0, 80);
  }
}

function parseGitHub(url: string): { owner: string; repo: string } {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") throw new Error("Only public github.com repositories are supported in bootstrap discovery.");
  const [owner, repoRaw] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) throw new Error("GitHub URL must include owner and repository.");
  return { owner, repo: repoRaw.replace(/\.git$/, "") };
}

async function discoverGitHubRepo(repoUrl: string, branch: string): Promise<DiscoveryDoc[]> {
  const { owner, repo } = parseGitHub(repoUrl);
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const treeResp = await fetch(treeUrl, { headers: { accept: "application/vnd.github+json" } });
  if (!treeResp.ok) throw new Error(`GitHub tree lookup failed (${treeResp.status})`);
  const tree = await treeResp.json() as { tree?: Array<{ path?: string; type?: string; size?: number }> };
  const candidates = (tree.tree ?? [])
    .filter(item => item.type === "blob" && item.path && isDiscoveryPath(item.path) && (item.size ?? 0) <= 250_000)
    .slice(0, DISCOVERY_FILE_CAP);
  const docs: DiscoveryDoc[] = [];
  let total = 0;
  for (const item of candidates) {
    const itemPath = item.path!;
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${itemPath.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(raw);
    if (!res.ok) continue;
    const content = (await res.text()).slice(0, DISCOVERY_SOURCE_CHAR_CAP);
    total += content.length;
    if (total > DISCOVERY_TOTAL_CHAR_CAP) break;
    docs.push({ title: itemPath, content, path: itemPath, sourceType: "GITHUB_REPO", sourceRef: repoUrl });
  }
  return docs;
}

async function fetchDocumentLink(doc: BootstrapDocumentInput): Promise<DiscoveryDoc> {
  const res = await fetch(doc.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const content = (await res.text()).slice(0, DISCOVERY_SOURCE_CHAR_CAP);
  return {
    title: doc.title ?? extractMarkdownTitle(content) ?? doc.url,
    content,
    sourceType: "DOCUMENT_LINK",
    sourceRef: doc.url,
  };
}

function discoverLocalSignals(files: InputFile[]): DiscoveryDoc[] {
  const docs: DiscoveryDoc[] = [];
  let total = 0;
  for (const file of files) {
    if (!isDiscoveryPath(file.path)) continue;
    const content = file.content.slice(0, DISCOVERY_SOURCE_CHAR_CAP);
    total += content.length;
    if (total > DISCOVERY_TOTAL_CHAR_CAP || docs.length >= DISCOVERY_FILE_CAP) break;
    docs.push({ title: file.path, content, path: file.path, sourceType: "LOCAL_FILE", sourceRef: LOCAL_BOOTSTRAP_REF });
  }
  return docs;
}

function isDiscoveryPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (/^README(\..*)?$/i.test(name)) return true;
  if (/^(CLAUDE|AGENTS)\.md$/i.test(name)) return true;
  if (normalized === ".github/copilot-instructions.md") return true;
  if (normalized.startsWith(".cursor/rules/")) return true;
  if (name === ".cursorrules" || name === ".windsurfrules") return true;
  if (normalized.startsWith(".claude/")) return true;
  if (/(\.codex\/skills\/|\/)?SKILL\.md$/i.test(normalized)) return true;
  if (/^docs\/.+\.md$/i.test(normalized)) return true;
  return false;
}

function selectBootstrapAgents(input: BootstrapInput): BootstrapAgentCatalogItem[] {
  const preset = input.agentPreset ?? "governed_delivery";
  const presetKeys = new Set(
    preset === "minimal"
      ? ["product_owner", "architect", "developer", "verifier", "governance"]
      : preset === "engineering_core"
        ? ["product_owner", "business_analyst", "architect", "developer", "verifier", "qa", "security", "devops", "governance"]
        : BOOTSTRAP_AGENT_CATALOG.map(agent => agent.key),
  );
  for (const key of input.includeAgentKeys ?? []) presetKeys.add(key);
  for (const key of input.excludeAgentKeys ?? []) {
    const agent = BOOTSTRAP_AGENT_CATALOG.find(item => item.key === key);
    if (agent?.activationRequired) continue;
    presetKeys.delete(key);
  }
  return BOOTSTRAP_AGENT_CATALOG.filter(agent => presetKeys.has(agent.key));
}

function capabilityAgentDescription(
  capabilityName: string,
  agent: BootstrapAgentCatalogItem,
  baseDescription?: string | null,
): string {
  const lock = agent.locked
    ? "This capability agent is locked: capability owners can activate or use it, but cannot edit its baseline prompt/tool policy without platform-admin review."
    : "This capability agent starts as a draft: capability owners can tune it before activation.";
  const learning = agent.learnsFromGit
    ? "It should use approved Git/doc/local learning candidates, capability knowledge artifacts, compiled context, and MCP AST/symbol tools before reading large files."
    : "It should rely on capability identity, policy, audit receipts, approvals, budget evidence, and required artifact lineage.";
  return [
    `${agent.description}`,
    `Capability grounding: ${agent.grounding}`,
    `Capability: ${capabilityName}.`,
    learning,
    lock,
    baseDescription ? `Platform baseline: ${baseDescription}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function buildLearningCandidates(docs: DiscoveryDoc[]): Array<{
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
}> {
  const groups = [
    { key: "capability_overview", title: "Capability overview", type: "CAPABILITY_OVERVIEW", test: (d: DiscoveryDoc) => /readme/i.test(d.path ?? d.title) },
    { key: "architecture_domain", title: "Architecture and domain vocabulary", type: "ARCHITECTURE_SUMMARY", test: (d: DiscoveryDoc) => /architecture|domain|design|docs\//i.test(`${d.path ?? ""}\n${d.content}`) },
    { key: "build_test_run", title: "Build, test, and run commands", type: "RUNBOOK", test: (d: DiscoveryDoc) => /(pnpm|npm|yarn|mvn|gradle|pytest|go test|cargo|docker|make|build|test|start|run)/i.test(d.content) },
    { key: "coding_conventions", title: "Coding conventions", type: "CODING_CONVENTIONS", test: (d: DiscoveryDoc) => /(convention|style|lint|format|cursor|windsurf|copilot|claude|agents|skill)/i.test(`${d.path ?? ""}\n${d.content}`) },
    { key: "agent_instructions", title: "Agent instructions", type: "AGENT_INSTRUCTIONS", test: (d: DiscoveryDoc) => /(CLAUDE|AGENTS|SKILL|\.claude|\.codex|copilot|cursor|windsurf)/i.test(d.path ?? d.title) },
    { key: "external_documentation", title: "External documentation facts", type: "EXTERNAL_DOC", test: (d: DiscoveryDoc) => d.sourceType === "DOCUMENT_LINK" },
  ];

  const out: Array<{
    groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
    sourceType: string; sourceRef: string; confidence: number;
  }> = [];
  for (const group of groups) {
    const hits = docs.filter(group.test).slice(0, 12);
    if (hits.length === 0) continue;
    out.push({
      groupKey: group.key,
      groupTitle: group.title,
      artifactType: group.type,
      title: group.title,
      content: formatCandidateContent(group.title, hits),
      sourceType: Array.from(new Set(hits.map(h => h.sourceType))).join(","),
      sourceRef: Array.from(new Set(hits.map(h => h.sourceRef))).join(","),
      confidence: group.key === "external_documentation" ? 0.8 : 0.75,
    });
  }
  return out;
}

function buildAgentGroundingCandidates(
  capabilityName: string,
  agents: BootstrapAgentCatalogItem[],
  docs: DiscoveryDoc[],
): Array<{
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
}> {
  if (agents.length === 0) return [];
  const sourceRefs = Array.from(new Set(docs.map(doc => doc.sourceRef).filter(Boolean))).join(",") || "capability-bootstrap";
  const gitBacked = agents.filter(agent => agent.learnsFromGit).map(agent => `- ${agent.label}: ${agent.grounding}`).join("\n");
  const locked = agents.filter(agent => agent.locked).map(agent => `- ${agent.label}: locked gate; activation required=${agent.activationRequired ? "yes" : "no"}`).join("\n");
  return [{
    groupKey: "agent_team_grounding",
    groupTitle: "Capability agent team grounding",
    artifactType: "AGENT_TEAM_GROUNDING",
    title: `${capabilityName} agent team grounding`,
    content: [
      `# ${capabilityName} agent team grounding`,
      "This candidate records the predefined capability agent team created by bootstrap. Approving it makes the operating model visible to runtime retrieval and later compiled-context capsules.",
      "",
      "## Git/doc grounded agents",
      gitBacked || "- No Git/doc-grounded agents selected.",
      "",
      "## Locked governance gates",
      locked || "- No locked gates selected.",
      "",
      "## Runtime rule",
      "All activated agents are capability-scoped. They should use approved capability knowledge, memory, code symbols, MCP AST slices, citations, budget receipts, and artifact lineage instead of ungrounded free-form context.",
    ].join("\n"),
    sourceType: "BOOTSTRAP_AGENT_CATALOG",
    sourceRef: sourceRefs,
    confidence: 0.9,
  }];
}

function buildArchitectureDiagramCandidate(
  capabilityName: string,
  diagram: CapabilityArchitectureDiagram,
): {
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
} {
  return {
    groupKey: "architecture_diagram",
    groupTitle: "Capability architecture diagram",
    artifactType: "ARCHITECTURE_DIAGRAM",
    title: `${capabilityName} architecture diagram`,
    content: [
      `# ${diagram.title}`,
      diagram.description,
      "",
      "```mermaid",
      diagram.mermaid,
      "```",
      "",
      "## Layers",
      ...diagram.layers.flatMap(layer => [
        "",
        `### ${layer.label}`,
        ...layer.items.map(item => `- ${item}`),
      ]),
    ].join("\n"),
    sourceType: "BOOTSTRAP_ARCHITECTURE",
    sourceRef: "capability-bootstrap:architecture-diagram",
    confidence: 0.9,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeArchitectureDiagram(value: unknown): CapabilityArchitectureDiagram | null {
  const raw = jsonRecord(value);
  const kind = raw.kind === "TOGAF_CAPABILITY_COLLECTION" ? raw.kind
    : raw.kind === "APPLICATION_CAPABILITY_ARCHITECTURE" ? raw.kind
      : null;
  const view = raw.view === "togaf" ? "togaf"
    : raw.view === "application" ? "application"
      : null;
  if (!kind || !view || typeof raw.title !== "string" || typeof raw.description !== "string" || typeof raw.mermaid !== "string") {
    return null;
  }
  const layers = Array.isArray(raw.layers)
    ? raw.layers.map(layer => {
      const row = jsonRecord(layer);
      return {
        key: typeof row.key === "string" ? row.key : "layer",
        label: typeof row.label === "string" ? row.label : "Layer",
        items: Array.isArray(row.items) ? row.items.map(String) : [],
      };
    })
    : [];
  return {
    kind,
    view,
    title: raw.title,
    description: raw.description,
    mermaid: raw.mermaid,
    layers,
  };
}

function buildCapabilityArchitectureDiagram(
  capability: { name: string; appId?: string | null; capabilityType?: string | null; criticality?: string | null },
  input: BootstrapInput,
  generatedAgents: Array<{ label: string; roleType: string; locked: boolean; learnsFromGit: boolean }>,
  docs: DiscoveryDoc[],
): CapabilityArchitectureDiagram {
  const capabilityName = capability.name;
  const collection = isCollectionCapabilityType(capability.capabilityType);
  const repos = (input.repositories ?? []).map(repo => repo.repoName?.trim() || repoNameFromUrl(repo.repoUrl)).filter(Boolean);
  const docCount = (input.documentLinks?.length ?? 0) + docs.filter(doc => doc.sourceType === "DOCUMENT_LINK").length;
  const localCount = input.localFiles?.length ?? 0;
  const agents = generatedAgents.map(agent => agent.label || agent.roleType);
  const appSuffix = capability.appId ? ` (${capability.appId})` : "";

  if (collection) {
    const layers = [
      { key: "business", label: "Business Architecture", items: [`${capabilityName}${appSuffix}`, "Outcomes, value streams, policies, owners"] },
      { key: "application", label: "Application Architecture", items: repos.length > 0 ? repos : ["Child applications / bounded contexts"] },
      { key: "data", label: "Data Architecture", items: [`${docCount || docs.length || 0} doc/source signals`, "Approved knowledge, memory, citations, artifacts"] },
      { key: "technology", label: "Technology Architecture", items: ["MCP workspaces, branches, AST index, local tools", "Context Fabric, Prompt Composer, Workgraph runtime"] },
      { key: "governance", label: "Governance", items: ["Locked governance/verifier/security agents", "Budgets, approvals, receipts, audit ledger"] },
    ];
    return {
      kind: "TOGAF_CAPABILITY_COLLECTION",
      title: `${capabilityName} TOGAF capability map`,
      view: "togaf",
      description: "Collection capabilities are shown as TOGAF-style business, application, data, technology, and governance layers so portfolio owners can see how child capabilities are governed.",
      layers,
      mermaid: [
        "flowchart TB",
        `  B[Business Architecture<br/>${escapeMermaid(capabilityName)}${capability.appId ? `<br/>App ID: ${escapeMermaid(capability.appId)}` : ""}]`,
        "  A[Application Architecture<br/>Child capabilities / applications]",
        "  D[Data Architecture<br/>Knowledge, memory, artifacts, citations]",
        "  T[Technology Architecture<br/>MCP workspaces, AST index, Context Fabric]",
        "  G[Governance<br/>Approvals, budgets, audit receipts]",
        "  B --> A --> D --> T --> G",
      ].join("\n"),
    };
  }

  const agentItems = agents.length > 0 ? agents : ["Product Owner", "Architect", "Developer", "QA", "Governance"];
  const layers = [
    { key: "entry", label: "Entry Points", items: ["Workflow stories, workbench stages, human approvals"] },
    { key: "agents", label: "Capability Agent Team", items: agentItems },
    { key: "knowledge", label: "Grounding Sources", items: [...(repos.length ? repos : ["Repository pending"]), `${docCount || docs.length || 0} document/source signals`, `${localCount} local files`] },
    { key: "execution", label: "Execution Runtime", items: ["Prompt Composer context plan", "Context Fabric token governor", "MCP model/tools/workspace"] },
    { key: "evidence", label: "Evidence Outputs", items: ["Stage artifacts", "Citations", "Budget receipts", "Audit trail"] },
  ];
  return {
    kind: "APPLICATION_CAPABILITY_ARCHITECTURE",
    title: `${capabilityName} application capability architecture`,
    view: "application",
    description: "Application capabilities are shown as a governed delivery architecture: stories enter Workgraph, agents work through Composer and Context Fabric, MCP supplies local code intelligence, and outputs become reviewable artifacts.",
    layers,
    mermaid: [
      "flowchart LR",
      "  S[Story / Workflow Input]",
      `  C[Capability<br/>${escapeMermaid(capabilityName)}${capability.appId ? `<br/>App ID: ${escapeMermaid(capability.appId)}` : ""}]`,
      "  A[Agent Team<br/>PO / Architect / Developer / QA / Governance]",
      "  K[Grounding<br/>Repos / Docs / Memory / Code Symbols]",
      "  X[Context Fabric + MCP<br/>Budget / Model / Tools / AST]",
      "  E[Evidence<br/>Artifacts / Citations / Receipts]",
      "  S --> C --> A",
      "  K --> A",
      "  A --> X --> E",
    ].join("\n"),
  };
}

function isCollectionCapabilityType(value?: string | null): boolean {
  const type = (value ?? "").trim().toUpperCase();
  return ["COLLECTION", "CAPABILITY_COLLECTION", "PORTFOLIO", "DOMAIN_COLLECTION"].includes(type);
}

function escapeMermaid(value: string): string {
  return value.replace(/[<>{}[\]|"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function learningWorkerSnapshot(capabilityId: string) {
  const [
    repositories,
    knowledgeSources,
    activeKnowledge,
    pendingLearning,
    materializedLearning,
    rejectedLearning,
    codeSymbols,
    distilledMemory,
    bootstrapRuns,
  ] = await Promise.all([
    prisma.capabilityRepository.count({ where: { capabilityId, status: "ACTIVE" } }),
    prisma.capabilityKnowledgeSource.count({ where: { capabilityId, status: "ACTIVE" } }),
    prisma.capabilityKnowledgeArtifact.count({ where: { capabilityId, status: "ACTIVE" } }),
    prisma.capabilityLearningCandidate.count({ where: { capabilityId, status: "PENDING" } }),
    prisma.capabilityLearningCandidate.count({ where: { capabilityId, status: "MATERIALIZED" } }),
    prisma.capabilityLearningCandidate.count({ where: { capabilityId, status: "REJECTED" } }),
    prisma.capabilityCodeSymbol.count({ where: { capabilityId } }),
    prisma.distilledMemory.count({ where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" } }),
    prisma.capabilityBootstrapRun.count({ where: { capabilityId } }),
  ]);

  return {
    repositories: { active: repositories },
    knowledgeSources: { active: knowledgeSources },
    knowledge: { active: activeKnowledge },
    learning: {
      pending: pendingLearning,
      materialized: materializedLearning,
      rejected: rejectedLearning,
    },
    codeSymbols: { total: codeSymbols },
    distilledMemory: { active: distilledMemory },
    bootstrapRuns: { total: bootstrapRuns },
  };
}

function formatCandidateContent(title: string, docs: DiscoveryDoc[]): string {
  const parts = [`# ${title}`];
  let chars = parts[0].length;
  for (const doc of docs) {
    const snippet = doc.content.trim().slice(0, 5_000);
    const next = `\n\n## Source: ${doc.title}\n${snippet}`;
    if (chars + next.length > 24_000) break;
    parts.push(next);
    chars += next.length;
  }
  return parts.join("");
}

function buildOperatingModel(
  capability: { name: string; appId?: string | null; capabilityType?: string | null },
  targetWorkflowPattern: string | undefined,
  generatedAgents: Array<{
    id: string;
    key?: string;
    roleType: string;
    bindingRole?: string;
    label?: string;
    name: string;
    baseTemplateId?: string | null;
    bindingId?: string;
    locked?: boolean;
    activationRequired?: boolean;
    learnsFromGit?: boolean;
    grounding?: string;
  }>,
  candidateGroups: number,
  architectureDiagram?: CapabilityArchitectureDiagram,
) {
  const capabilityName = capability.name;
  const pattern = (targetWorkflowPattern?.trim() || "governed_delivery").toLowerCase();
  const starterWorkflow = pattern.includes("support")
    ? "Intake -> Product Owner triage -> Developer fix plan -> QA proof -> Human approval -> Handoff"
    : pattern.includes("security")
      ? "Intake -> Architect scope -> Security review -> Developer remediation -> QA verification -> Human approval"
      : "Intake -> Architect plan -> Developer implementation -> QA proof -> Security review -> DevOps release note -> Human approval";
  return {
    name: `${capabilityName} operating model`,
    appId: capability.appId ?? null,
    capabilityType: capability.capabilityType ?? null,
    targetWorkflowPattern: pattern,
    starterWorkflow,
    architectureDiagram,
    draftAgents: generatedAgents.map(agent => ({
      id: agent.id,
      key: agent.key,
      roleType: agent.roleType,
      bindingRole: agent.bindingRole ?? agent.roleType,
      label: agent.label ?? agent.roleType,
      name: agent.name,
      bindingId: agent.bindingId,
      locked: agent.locked === true,
      activationRequired: agent.activationRequired === true,
      learnsFromGit: agent.learnsFromGit === true,
      grounding: agent.grounding,
      activation: agent.activationRequired ? "required during review" : "requires human review",
    })),
    suggestedTools: [
      { name: "repo.search", reason: "Locate code and docs without full-file prompt payloads.", status: "suggested" },
      { name: "workbench.create_artifact", reason: "Capture architecture, implementation, QA, and release evidence as versioned artifacts.", status: "suggested" },
      { name: "approval.request", reason: "Pause after major artifact production before downstream promotion.", status: "suggested" },
    ],
    artifactContracts: [
      "architecture_decision",
      "implementation_plan",
      "code_patch",
      "qa_proof",
      "security_review",
      "release_note",
      "final_handoff",
    ],
    approvalGates: [
      "Activate generated agents",
      "Locked Governance / Verifier / Security gates must stay enabled",
      "Materialize learned knowledge",
      "Promote major artifacts",
      "Approve budget/tool pauses",
    ],
    learningReview: {
      candidateGroups,
      runtimeVisibleAfterApproval: true,
    },
  };
}

function deterministicSymbolSummary(symbol: {
  symbolName: string;
  symbolType: string;
  language?: string;
  filePath: string;
  startLine?: number;
}): string {
  const location = `${symbol.filePath}${symbol.startLine ? `:${symbol.startLine}` : ""}`;
  return `${symbol.symbolType} ${symbol.symbolName} in ${symbol.language ?? "source"} at ${location}. Deterministic summary generated from symbol metadata; enable ENABLE_LLM_SYMBOL_SUMMARIES=1 for richer summaries.`;
}

async function ensureDefaultGovernanceLimits(capabilityId: string): Promise<string | undefined> {
  const baseUrl = (process.env.AUDIT_GOV_URL ?? process.env.AUDIT_GOVERNANCE_URL ?? "http://localhost:8500").replace(/\/$/, "");
  const tokensMax = Number(process.env.CAPABILITY_DEFAULT_DAILY_TOKENS ?? 200_000);
  const costMaxUsd = Number(process.env.CAPABILITY_DEFAULT_DAILY_COST_USD ?? 2);
  const maxCalls = Number(process.env.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE ?? 30);
  try {
    const [budgetRes, rateRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/governance/budgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope_type: "capability",
          scope_id: capabilityId,
          period: "day",
          tokens_max: Number.isFinite(tokensMax) && tokensMax > 0 ? Math.floor(tokensMax) : null,
          cost_max_usd: Number.isFinite(costMaxUsd) && costMaxUsd >= 0 ? costMaxUsd : null,
        }),
        signal: AbortSignal.timeout(5_000),
      }),
      fetch(`${baseUrl}/api/v1/governance/rate-limits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope_type: "capability",
          scope_id: capabilityId,
          period_seconds: 60,
          max_calls: Number.isFinite(maxCalls) && maxCalls > 0 ? Math.floor(maxCalls) : 30,
        }),
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    if (!budgetRes.ok || !rateRes.ok) {
      return `Default governance budget/rate-limit returned HTTP ${budgetRes.status}/${rateRes.status}`;
    }
  } catch (err) {
    return `Default governance budget/rate-limit was not created: ${(err as Error).message}`;
  }
  return undefined;
}

function extractMarkdownTitle(md: string): string | undefined {
  const found = md.match(/^#\s+(.+)$/m);
  return found?.[1]?.trim().slice(0, 200);
}

function isApprovedSource(approved: Array<{ sourceRef: string | null; sourceType: string | null }>, sourceRef: string): boolean {
  return approved.some(item => item.sourceRef?.includes(sourceRef));
}

function assertCapabilityNotArchived(capability: { status: string }): void {
  if (capability.status === "ARCHIVED") {
    throw new ForbiddenError("Capability is archived and cannot be modified.");
  }
}

async function assertCodeExtractionApproved(
  capabilityId: string,
  repo: { repoName: string; repoUrl: string; repositoryType: string | null },
): Promise<void> {
  const hasBootstrap = await prisma.capabilityBootstrapRun.count({ where: { capabilityId } });
  if (hasBootstrap === 0) return;

  const approved = await prisma.capabilityLearningCandidate.findMany({
    where: { capabilityId, status: "MATERIALIZED" },
    select: { sourceRef: true, sourceType: true },
  });

  const approvedForRepo = repo.repositoryType === "LOCAL" || repo.repoUrl.startsWith("local://")
    ? approved.some(item => item.sourceRef?.includes(LOCAL_BOOTSTRAP_REF) || item.sourceType === "LOCAL_FILE")
    : isApprovedSource(approved, repo.repoUrl);

  if (!approvedForRepo) {
    throw new ForbiddenError(`Code context for ${repo.repoName} requires approved bootstrap learning first.`);
  }
}
