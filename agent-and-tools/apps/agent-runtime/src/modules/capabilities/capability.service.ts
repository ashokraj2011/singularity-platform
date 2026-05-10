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
