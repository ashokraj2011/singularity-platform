import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ForbiddenError, NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import { extractSymbols, type InputFile } from "./symbol-extractor";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "@agentandtools/shared";
import { summariseSymbol, fileSnippetFor } from "../../lib/llm/summarise";
import { syncIamCapabilityReference } from "./iam-capability-reference";

const DEFAULT_BOOTSTRAP_ROLES = [
  "ARCHITECT",
  "DEVELOPER",
  "QA",
  "SECURITY",
  "DEVOPS",
  "PRODUCT_OWNER",
] as const;

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
  parentCapabilityId?: string;
  capabilityType?: string;
  businessUnitId?: string;
  ownerTeamId?: string;
  criticality?: string;
  description?: string;
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

export const capabilityService = {
  async create(input: {
    name: string; parentCapabilityId?: string; capabilityType?: string;
    businessUnitId?: string; ownerTeamId?: string; criticality?: string; description?: string;
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

    const generatedAgents: Array<{ id: string; roleType: string; name: string; baseTemplateId?: string | null; bindingId?: string }> = [];
    const discovered: DiscoveryDoc[] = [];

    try {
      const common = await prisma.agentTemplate.findMany({
        where: { capabilityId: null, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });

      for (const role of DEFAULT_BOOTSTRAP_ROLES) {
        const base = common.find(t => t.roleType === role);
        if (!base) warnings.push(`No common ${role} base template found; created a draft placeholder.`);
        const template = await prisma.agentTemplate.create({
          data: {
            name: `${capability.name} ${role.replace("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())} Agent`,
            roleType: role,
            description: base?.description ?? `Draft ${role} agent generated during capability bootstrap. Review prompts and tools before activation.`,
            basePromptProfileId: base?.basePromptProfileId ?? undefined,
            defaultToolPolicyId: base?.defaultToolPolicyId ?? undefined,
            capabilityId: capability.id,
            baseTemplateId: base?.id ?? undefined,
            lockedReason: null,
            status: "DRAFT",
            createdBy: userId,
          },
        });
        const binding = await prisma.agentCapabilityBinding.create({
          data: {
            capabilityId: capability.id,
            agentTemplateId: template.id,
            bindingName: `${role} binding`,
            roleInCapability: role,
            status: "DRAFT",
            createdBy: userId,
          },
        });
        generatedAgents.push({ id: template.id, roleType: role, name: template.name, baseTemplateId: base?.id, bindingId: binding.id });
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

      const candidates = buildLearningCandidates(discovered);
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

    if (input.activateAgentTemplateIds.length > 0) {
      await prisma.agentTemplate.updateMany({
        where: { capabilityId, id: { in: input.activateAgentTemplateIds } },
        data: { status: "ACTIVE" },
      });
      await prisma.agentCapabilityBinding.updateMany({
        where: { capabilityId, agentTemplateId: { in: input.activateAgentTemplateIds } },
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

  async update(id: string, input: {
    name?: string;
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
