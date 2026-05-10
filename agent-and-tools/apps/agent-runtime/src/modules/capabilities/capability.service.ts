import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import { extractSymbols, type InputFile } from "./symbol-extractor";
import { getEmbeddingProvider } from "../../lib/embeddings";

export const capabilityService = {
  async create(input: {
    name: string; parentCapabilityId?: string; capabilityType?: string;
    businessUnitId?: string; ownerTeamId?: string; criticality?: string; description?: string;
  }) {
    return prisma.capability.create({ data: { ...input, status: "ACTIVE" } });
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
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");
    return cap;
  },

  async attachRepository(capabilityId: string, input: {
    repoName: string; repoUrl: string; defaultBranch: string; repositoryType: string;
  }) {
    await this.get(capabilityId);
    return prisma.capabilityRepository.create({
      data: { ...input, capabilityId, status: "ACTIVE" },
    });
  },

  async bindAgent(capabilityId: string, input: {
    agentTemplateId: string; bindingName: string;
    roleInCapability?: string; promptProfileId?: string;
    toolPolicyId?: string; memoryScopePolicyId?: string;
  }, userId?: string) {
    await this.get(capabilityId);
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");
    return prisma.agentCapabilityBinding.create({
      data: { ...input, capabilityId, createdBy: userId, status: "ACTIVE" },
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
    await this.get(capabilityId);
    return prisma.capabilityKnowledgeArtifact.create({
      data: {
        capabilityId,
        artifactType: input.artifactType,
        title: input.title,
        content: input.content,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        confidence: input.confidence,
        contentHash: sha256(input.content),
        status: "ACTIVE",
      },
    });
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
    await this.get(capabilityId);
    const repo = await prisma.capabilityRepository.findUnique({ where: { id: repositoryId } });
    if (!repo || repo.capabilityId !== capabilityId) {
      throw new NotFoundError("Repository not found for this capability");
    }
    const symbols = extractSymbols(files);
    const embedder = getEmbeddingProvider();

    let inserted = 0;
    let skippedDuplicate = 0;
    let embeddingErrors = 0;

    for (const s of symbols) {
      const existing = await prisma.capabilityCodeSymbol.findFirst({
        where: { repositoryId, symbolHash: s.symbolHash },
        select: { id: true },
      });
      if (existing) { skippedDuplicate += 1; continue; }

      const row = await prisma.capabilityCodeSymbol.create({
        data: {
          capabilityId,
          repositoryId,
          filePath: s.filePath,
          language: s.language,
          symbolName: s.symbolName,
          symbolType: s.symbolType,
          startLine: s.startLine,
          summary: s.summary,
          symbolHash: s.symbolHash,
        },
      });
      inserted += 1;

      try {
        const embedTarget = `${s.symbolName}\n${s.summary ?? ""}`.trim();
        const embedded = await embedder.embed({ text: embedTarget });
        // v0 stores the vector as a JSON-encoded string in `vectorId`; pgvector
        // upgrade is a follow-up. `embeddingModel` includes the provider so a
        // future migration can re-embed only mismatched rows.
        await prisma.capabilityCodeEmbedding.create({
          data: {
            symbolId: row.id,
            embeddingModel: `${embedded.provider}:${embedded.model}:${embedded.dim}`,
            vectorId: JSON.stringify(embedded.vector),
            summary: s.summary,
          },
        });
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
      provider: embedder.name,
      providerModel: embedder.defaultModel,
    };
  },
};
