/**
 * M18 — internal server-side tool executors.
 *
 * tool-service registers each of these in `tool.tools` with
 * runtime.execution_location="server" and runtime.endpoint_url pointing
 * here. The /api/v1/tools/invoke router (execution.ts) does the HTTP fan-out
 * → these handlers receive the tool args directly.
 *
 * Tools:
 *   - recall_memory:    semantic search over DistilledMemory
 *   - search_knowledge: semantic search over CapabilityKnowledgeArtifact
 *   - search_symbols:   semantic search over CapabilityCodeSymbol (joined to embeddings)
 *   - summarise_text:   LLM gateway wrapper
 *   - extract_entities: LLM gateway wrapper that asks for JSON entities
 *
 * The first three use M15's pgvector + the same hybrid scoring formula
 * (cosine × recency boost) as the prompt-composer. The LLM wrappers post
 * directly to the central LLM gateway (/v1/chat/completions) — provider
 * keys live only on llm-gateway-service.
 */
import { Router, Request, Response } from "express";
import { query } from "../database";
import { getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral } from "@agentandtools/shared";

const RECENCY_BOOST_DAYS = Number(process.env.EMBEDDING_RECENCY_DAYS ?? 30);
const RECENCY_BOOST_MAX  = Number(process.env.EMBEDDING_RECENCY_BOOST ?? 0.2);
const LLM_GATEWAY_URL    = process.env.LLM_GATEWAY_URL    ?? "http://llm-gateway:8001";
const LLM_GATEWAY_BEARER = process.env.LLM_GATEWAY_BEARER ?? "";
const TOOL_LLM_MODEL_ALIAS = process.env.TOOL_LLM_MODEL_ALIAS?.trim();

function recencyBoost(ageDays: number): number {
  if (ageDays >= RECENCY_BOOST_DAYS) return 0;
  if (ageDays <= 0) return RECENCY_BOOST_MAX;
  return ((RECENCY_BOOST_DAYS - ageDays) / RECENCY_BOOST_DAYS) * RECENCY_BOOST_MAX;
}

function rerank<T extends { cosineSimilarity: number; ageDays: number; finalScore: number }>(rows: T[], take: number): T[] {
  for (const r of rows) r.finalScore = r.cosineSimilarity * (1 + recencyBoost(r.ageDays));
  rows.sort((a, b) => b.finalScore - a.finalScore);
  return rows.slice(0, take);
}

async function embedQuery(text: string): Promise<string> {
  const embedded = await getEmbeddingProvider().embed({ text: text.slice(0, 8_000) });
  assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
  return toVectorLiteral(embedded.vector);
}

export const internalToolsRoutes = Router();

// ── recall_memory ───────────────────────────────────────────────────────────

internalToolsRoutes.post("/recall_memory", async (req: Request, res: Response) => {
  const { capability_id, query: q, limit } = req.body ?? {};
  if (!capability_id || !q) return res.status(400).json({ error: "capability_id + query required" });
  const take = Math.min(Math.max(Number(limit ?? 5), 1), 20);
  const vec = await embedQuery(String(q));
  const rows = await query<{
    id: string; memoryType: string; title: string; content: string;
    cosine_similarity: number; age_days: number;
  }>(
    `SELECT id, "memoryType", title, content,
            1 - (embedding <=> $1::vector) AS cosine_similarity,
            EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days
     FROM "DistilledMemory"
     WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $2
       AND status = 'ACTIVE' AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 30`,
    [vec, capability_id],
  );
  const hits = rerank(rows.map((r) => ({
    id: r.id, type: r.memoryType, title: r.title, content: r.content,
    cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days), finalScore: 0,
  })), take);
  res.json({ query: q, count: hits.length, hits });
});

// ── search_knowledge ────────────────────────────────────────────────────────

internalToolsRoutes.post("/search_knowledge", async (req: Request, res: Response) => {
  const { capability_id, query: q, limit } = req.body ?? {};
  if (!capability_id || !q) return res.status(400).json({ error: "capability_id + query required" });
  const take = Math.min(Math.max(Number(limit ?? 5), 1), 20);
  const vec = await embedQuery(String(q));
  const rows = await query<{
    id: string; artifactType: string; title: string; content: string;
    cosine_similarity: number; age_days: number;
  }>(
    `SELECT id, "artifactType", title, content,
            1 - (embedding <=> $1::vector) AS cosine_similarity,
            EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days
     FROM "CapabilityKnowledgeArtifact"
     WHERE "capabilityId" = $2 AND status = 'ACTIVE' AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 30`,
    [vec, capability_id],
  );
  const hits = rerank(rows.map((r) => ({
    id: r.id, type: r.artifactType, title: r.title, content: r.content,
    cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days), finalScore: 0,
  })), take);
  res.json({ query: q, count: hits.length, hits });
});

// ── search_symbols ──────────────────────────────────────────────────────────

internalToolsRoutes.post("/search_symbols", async (req: Request, res: Response) => {
  const { capability_id, query: q, limit } = req.body ?? {};
  if (!capability_id || !q) return res.status(400).json({ error: "capability_id + query required" });
  const take = Math.min(Math.max(Number(limit ?? 8), 1), 20);
  const vec = await embedQuery(String(q));
  const rows = await query<{
    symbol_id: string; symbolName: string | null; symbolType: string | null;
    filePath: string; startLine: number | null; summary: string | null;
    language: string | null; repoName: string;
    cosine_similarity: number; age_days: number;
  }>(
    `SELECT s.id AS symbol_id, s."symbolName", s."symbolType", s."filePath", s."startLine",
            s.summary, s.language, r."repoName",
            1 - (e.embedding <=> $1::vector) AS cosine_similarity,
            EXTRACT(EPOCH FROM (now() - s."createdAt")) / 86400.0 AS age_days
     FROM "CapabilityCodeEmbedding" e
     JOIN "CapabilityCodeSymbol" s ON s.id = e."symbolId"
     JOIN "CapabilityRepository" r ON r.id = s."repositoryId"
     WHERE s."capabilityId" = $2 AND e.embedding IS NOT NULL
     ORDER BY e.embedding <=> $1::vector
     LIMIT 30`,
    [vec, capability_id],
  );
  const hits = rerank(rows.map((r) => ({
    id: r.symbol_id, name: r.symbolName, kind: r.symbolType,
    repo: r.repoName, file: r.filePath, line: r.startLine,
    summary: r.summary, language: r.language,
    cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days), finalScore: 0,
  })), take);
  res.json({ query: q, count: hits.length, hits });
});

// ── summarise_text ──────────────────────────────────────────────────────────

internalToolsRoutes.post("/summarise_text", async (req: Request, res: Response) => {
  const { text, max_chars } = req.body ?? {};
  if (typeof text !== "string" || text.length === 0) return res.status(400).json({ error: "text required" });
  const cap = Math.min(Math.max(Number(max_chars ?? 280), 80), 800);
  const r = await callMcp({
    systemPrompt: `You write concise summaries. Reply with a single paragraph (<=${cap} chars). No markdown, no preamble.`,
    message: `Summarise:\n${String(text).slice(0, 12_000)}`,
  });
  res.json({ summary: r.slice(0, cap) });
});

// ── extract_entities ────────────────────────────────────────────────────────

internalToolsRoutes.post("/extract_entities", async (req: Request, res: Response) => {
  const { text, kinds } = req.body ?? {};
  if (typeof text !== "string" || text.length === 0) return res.status(400).json({ error: "text required" });
  const wanted = Array.isArray(kinds) && kinds.length > 0 ? kinds.join(", ") : "person, org, location, date, amount, identifier";
  const r = await callMcp({
    systemPrompt:
      "Extract named entities from the text. Return STRICT JSON: " +
      "{\"entities\":[{\"kind\":string,\"value\":string,\"confidence\":number}]}. " +
      "No commentary, no markdown. Use only the requested kinds.",
    message: `Kinds: ${wanted}\n\nText:\n${String(text).slice(0, 12_000)}`,
  });
  // Best-effort JSON parse with synthetic empty fallback (mock provider noise).
  const m = r.match(/\{[\s\S]*\}/);
  let parsed: { entities: Array<{ kind: string; value: string; confidence?: number }> } = { entities: [] };
  if (m) { try { parsed = JSON.parse(m[0]); } catch { /* swallow */ } }
  res.json({ entities: Array.isArray(parsed.entities) ? parsed.entities : [], raw: r.slice(0, 600) });
});

// ── shared LLM gateway call (M33) ──────────────────────────────────────────
//
// Pure synthesis calls (no tools, no loop) go directly to the central LLM
// gateway. No provider keys live in tool-service.
async function callMcp(opts: { systemPrompt: string; message: string }): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${LLM_GATEWAY_BEARER}`;
  const res = await fetch(`${LLM_GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(TOOL_LLM_MODEL_ALIAS ? { model_alias: TOOL_LLM_MODEL_ALIAS } : {}),
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user",   content: opts.message },
      ],
      temperature: 0,
      max_output_tokens: 1500,
      trace_id: `tool-${Date.now()}`,
    }),
    signal: AbortSignal.timeout(70_000),
  });
  if (!res.ok) throw new Error(`LLM_GATEWAY_UPSTREAM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content?: string };
  return (data.content ?? "").trim();
}

// Required-dim guard surfaced for visibility in /healthz-style probes.
void REQUIRED_EMBEDDING_DIM;
