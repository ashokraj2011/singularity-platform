/**
 * M38 — Cross-workflow lessons learned service.
 *
 * Embeds + persists rules extracted from audit-gov's confirmed-resolved
 * failure clusters, and exposes a semantic-retrieval helper used by
 * compose.service at assembly time.
 *
 * Reuses the shared embeddings client (same provider/dim as memory + code
 * + knowledge) so cosine similarity is comparable across all four sources.
 */
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import {
  getEmbeddingProvider,
  REQUIRED_EMBEDDING_DIM,
  assertDimMatches,
  toVectorLiteral,
} from "@agentandtools/shared";
import type { CreateLessonInput, LessonRow } from "./lessons.schemas";

/** Cosine-similarity threshold above which a new lesson supersedes an older
 *  one on the same (capabilityId, toolName) scope. Tuned to be conservative —
 *  only near-duplicate rules supersede; semantically related ones coexist. */
const SUPERSEDE_COSINE_THRESHOLD = Number(process.env.LESSON_SUPERSEDE_COSINE ?? 0.85);

/** Max active lessons per (capabilityId, toolName) tuple — prevents the
 *  layer from bloating prompts as the catalog grows. Older lessons with
 *  lower confidence get archived when this is exceeded. */
const MAX_ACTIVE_PER_SCOPE = Number(process.env.LESSON_MAX_ACTIVE_PER_SCOPE ?? 20);

export const lessonsService = {
  async create(input: CreateLessonInput): Promise<LessonRow> {
    // 1. Embed the rule text.
    const embedded = await getEmbeddingProvider().embed({ text: input.ruleText.slice(0, 4_000) });
    assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
    const vectorLiteral = toVectorLiteral(embedded.vector);

    // 2. Insert the row (vector via raw SQL since Prisma can't bind Unsupported).
    const created = await prisma.engineLesson.create({
      data: {
        capabilityId: input.capabilityId,
        toolName: input.toolName ?? null,
        ruleText: input.ruleText,
        sourceIssueId: input.sourceIssueId ?? null,
        sourceTraceIds: input.sourceTraceIds,
        confidence: input.confidence,
        extractedBy: input.extractedBy ?? "audit-gov:engine:sweep",
        isActive: true,
      },
    });
    // Set the vector via raw UPDATE (only path Prisma supports for Unsupported types).
    await prisma.$executeRawUnsafe(
      `UPDATE "EngineLesson" SET embedding = $1::vector WHERE id = $2`,
      vectorLiteral,
      created.id,
    );

    // 3. Supersession sweep — if any existing active lesson on the same scope
    //    is near-duplicate AND has lower confidence, mark it superseded.
    await this.markSuperseded(created.id, input.capabilityId, input.toolName ?? null, vectorLiteral, input.confidence);

    // 4. Cap-enforce — if scope now has more than MAX_ACTIVE_PER_SCOPE active
    //    lessons, archive the lowest-confidence oldest ones.
    await this.enforceActiveCap(input.capabilityId, input.toolName ?? null);

    return created as unknown as LessonRow;
  },

  async markSuperseded(
    newId: string,
    capabilityId: string,
    toolName: string | null,
    newVectorLiteral: string,
    newConfidence: number,
  ): Promise<void> {
    type Hit = { id: string; confidence: number; similarity: number };
    const rows = await prisma.$queryRawUnsafe<Hit[]>(
      `SELECT id, confidence,
              1 - (embedding <=> $1::vector) AS similarity
       FROM "EngineLesson"
       WHERE "capabilityId" = $2
         AND ("toolName" = $3 OR ($3 IS NULL AND "toolName" IS NULL))
         AND "isActive" = true
         AND id != $4
         AND embedding IS NOT NULL`,
      newVectorLiteral, capabilityId, toolName, newId,
    );
    const toSupersede = rows.filter(
      (r) => Number(r.similarity) >= SUPERSEDE_COSINE_THRESHOLD && Number(r.confidence) <= newConfidence,
    );
    if (toSupersede.length === 0) return;
    await prisma.engineLesson.updateMany({
      where: { id: { in: toSupersede.map((r) => r.id) } },
      data: { isActive: false, supersededBy: newId },
    });
    logger.info(
      { newId, capabilityId, toolName, superseded: toSupersede.length },
      "[lessons] near-duplicate older lessons superseded",
    );
  },

  async enforceActiveCap(capabilityId: string, toolName: string | null): Promise<void> {
    const active = await prisma.engineLesson.findMany({
      where: {
        capabilityId,
        toolName,
        isActive: true,
      },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    });
    if (active.length <= MAX_ACTIVE_PER_SCOPE) return;
    const archive = active.slice(MAX_ACTIVE_PER_SCOPE);
    await prisma.engineLesson.updateMany({
      where: { id: { in: archive.map((l) => l.id) } },
      data: { isActive: false },
    });
    logger.info(
      { capabilityId, toolName, archived: archive.length },
      "[lessons] active-cap exceeded; lower-confidence older lessons archived",
    );
  },

  async list(capabilityId?: string): Promise<LessonRow[]> {
    const rows = await prisma.engineLesson.findMany({
      where: { isActive: true, ...(capabilityId ? { capabilityId } : {}) },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    return rows as unknown as LessonRow[];
  },

  async deactivate(id: string, reason?: string, supersededBy?: string): Promise<void> {
    await prisma.engineLesson.update({
      where: { id },
      data: { isActive: false, supersededBy: supersededBy ?? null },
    });
    logger.info({ id, reason, supersededBy }, "[lessons] manually deactivated");
  },

  /**
   * Semantic retrieval used by compose.service.ts at assembly time.
   * Returns the top-K active lessons matching the task vector, scoped to
   * the capability (and optionally narrowed by tool name).
   *
   * Mirrors the shape of semanticMemory/semanticKnowledge in compose.service.
   */
  async semanticLessons(
    capabilityId: string,
    taskVec: string,
    opts?: { toolName?: string; take?: number },
  ): Promise<Array<{
    id: string;
    ruleText: string;
    toolName: string | null;
    confidence: number;
    cosineSimilarity: number;
  }>> {
    const take = opts?.take ?? 3;
    const candidatePool = take * 5;
    type Row = {
      id: string;
      ruleText: string;
      toolName: string | null;
      confidence: number;
      cosine_similarity: number;
    };
    // Tool-narrowed lessons rank above capability-only lessons; we union and let
    // the cosine sort sort them out, but bias tool-matched ones by +0.05 cosine
    // so they tend to win ties (configurable via env if it ever matters).
    const toolBoost = Number(process.env.LESSON_TOOL_MATCH_BOOST ?? 0.05);
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id,
              "ruleText",
              "toolName",
              confidence,
              CASE
                WHEN "toolName" = $3 THEN (1 - (embedding <=> $1::vector)) + ${toolBoost}
                ELSE (1 - (embedding <=> $1::vector))
              END AS cosine_similarity
       FROM "EngineLesson"
       WHERE "capabilityId" = $2
         AND "isActive" = true
         AND embedding IS NOT NULL
       ORDER BY cosine_similarity DESC
       LIMIT ${candidatePool}`,
      taskVec, capabilityId, opts?.toolName ?? null,
    );
    // Light filter: drop anything below a meaningful similarity floor. The
    // boost above can push tool-matched lessons above the floor even when
    // their raw cosine is borderline — that's the desired tie-break.
    const floor = Number(process.env.LESSON_RETRIEVAL_FLOOR ?? 0.3);
    return rows
      .filter((r) => Number(r.cosine_similarity) >= floor)
      .slice(0, take)
      .map((r) => ({
        id: r.id,
        ruleText: r.ruleText,
        toolName: r.toolName,
        confidence: Number(r.confidence),
        cosineSimilarity: Number(r.cosine_similarity),
      }));
  },
};

// Re-export the embedding dim sanity-check constant for callers that need to
// validate the column matches the provider before issuing semantic queries.
export { REQUIRED_EMBEDDING_DIM };
