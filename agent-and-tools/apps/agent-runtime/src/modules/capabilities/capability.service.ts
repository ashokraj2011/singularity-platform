import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import { extractSymbols, type InputFile } from "./symbol-extractor";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "../../lib/embeddings";
import { summariseSymbol, fileSnippetFor } from "../../lib/llm/summarise";

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
    const created = await prisma.capabilityKnowledgeArtifact.create({
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

    // M15 — embed-on-write. Failure logs and continues; the row still lands
    // and the composer simply won't pick it up via semantic search until a
    // backfill/re-upload. Prisma can't bind `vector(N)`, so we use raw SQL.
    try {
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
    await this.get(capabilityId);
    const repo = await prisma.capabilityRepository.findUnique({ where: { id: repositoryId } });
    if (!repo || repo.capabilityId !== capabilityId) {
      throw new NotFoundError("Repository not found for this capability");
    }
    const symbols = await extractSymbols(files);
    const embedder = getEmbeddingProvider();

    // Index files by path so we can pull a snippet for the LLM summariser.
    const fileByPath = new Map(files.map((f) => [f.path, f.content]));

    let inserted = 0;
    let skippedDuplicate = 0;
    let embeddingErrors = 0;
    let llmSummaries = 0;

    for (const s of symbols) {
      const existing = await prisma.capabilityCodeSymbol.findFirst({
        where: { repositoryId, symbolHash: s.symbolHash },
        select: { id: true, embeddings: { select: { id: true, embedding: true } } },
      });
      if (existing) {
        // Symbol already exists. Skip the row write but re-embed if no
        // pgvector embedding lives for it yet — common after migrating M14
        // rows where vectorId was JSON text and `embedding` is null.
        const hasEmbedding = existing.embeddings.some((e) => e.embedding !== null);
        if (hasEmbedding) { skippedDuplicate += 1; continue; }
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

      // M15 — when the extractor didn't find a docstring, call the LLM
      // summariser. Best-effort; null falls through to NULL summary.
      let summary = s.summary ?? null;
      if (!summary) {
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

      const row = await prisma.capabilityCodeSymbol.create({
        data: {
          capabilityId,
          repositoryId,
          filePath: s.filePath,
          language: s.language,
          symbolName: s.symbolName,
          symbolType: s.symbolType,
          startLine: s.startLine,
          summary,
          symbolHash: s.symbolHash,
        },
      });
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
      provider: embedder.name,
      providerModel: embedder.defaultModel,
      requiredDim: REQUIRED_EMBEDDING_DIM,
    };
  },
};
