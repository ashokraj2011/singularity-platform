/**
 * M25.5 C8 — operator-facing audit endpoints for compiled context capsules.
 *
 *   GET  /api/v1/compiled-contexts/:id          — fetch one row + decoded body
 *   GET  /api/v1/compiled-contexts/:id/compare  — compiled-vs-raw side-by-side
 *
 * The compare path is the quality-regression audit hatch: when the LLM-compile
 * mode (M25.5.next) is enabled, an operator needs to be able to inspect the
 * paragraph the agent actually saw against the underlying retrieval chunks so
 * they can spot hallucinated or stale citations.
 *
 * Response is read-only and shape-stable; the SPA can render a left/right diff
 * without further coordination.
 */
import { Router } from "express";
import { prisma } from "../../config/prisma";
import { compileSlotSnapshot } from "./capsule-gc";

export const compiledContextRoutes = Router();

compiledContextRoutes.get("/", async (req, res, next) => {
  try {
    const capabilityId = typeof req.query.capabilityId === "string" ? req.query.capabilityId : undefined;
    const agentTemplateId = typeof req.query.agentTemplateId === "string" ? req.query.agentTemplateId : undefined;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const rows = await prisma.capabilityCompiledContext.findMany({
      where: {
        ...(capabilityId ? { capabilityId } : {}),
        ...(agentTemplateId ? { agentTemplateId } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true, capabilityId: true, agentTemplateId: true, intent: true,
        compileMode: true, status: true, hitCount: true, estimatedTokens: true,
        expiresAt: true, createdAt: true, updatedAt: true,
      },
    });
    res.json({
      success: true,
      data: { items: rows, total: rows.length, inflight: compileSlotSnapshot() },
      requestId: res.locals.requestId,
    });
  } catch (err) { next(err); }
});

compiledContextRoutes.get("/:id", async (req, res, next) => {
  try {
    const row = await prisma.capabilityCompiledContext.findUnique({
      where: { id: req.params.id },
    });
    if (!row) return res.status(404).json({ success: false, error: "compiled context not found" });
    res.json({
      success: true,
      data: { ...row },
      requestId: res.locals.requestId,
    });
  } catch (err) { next(err); }
});

compiledContextRoutes.get("/:id/compare", async (req, res, next) => {
  try {
    const row = await prisma.capabilityCompiledContext.findUnique({
      where: { id: req.params.id },
    });
    if (!row) return res.status(404).json({ success: false, error: "compiled context not found" });
    const citations = (row.citations ?? []) as Array<{
      citation_key?: string; content?: string; source_kind?: string; confidence?: number;
    }>;
    // Rebuild a "raw equivalent" view from citations. For LLM-mode capsules
    // this is what the agent would have seen without the compile step; for
    // RAW capsules it mirrors the cached compiledContent.
    const rawApproximation = citations
      .map((c, i) => `[${i + 1}] ${c.source_kind ?? "?"} ${c.citation_key ?? ""}\n${(c.content ?? "").slice(0, 500)}`)
      .join("\n\n");
    res.json({
      success: true,
      data: {
        id: row.id,
        capabilityId: row.capabilityId,
        agentTemplateId: row.agentTemplateId,
        intent: row.intent,
        compileMode: row.compileMode,
        status: row.status,
        compiledContent: row.compiledContent,
        rawApproximation,
        citationsCount: citations.length,
        citations: citations.map((c, i) => ({
          index: i + 1,
          citation_key: c.citation_key,
          source_kind: c.source_kind,
          confidence: c.confidence,
          excerpt: (c.content ?? "").slice(0, 500),
        })),
        estimatedTokens: row.estimatedTokens,
        hitCount: row.hitCount,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      requestId: res.locals.requestId,
    });
  } catch (err) { next(err); }
});
