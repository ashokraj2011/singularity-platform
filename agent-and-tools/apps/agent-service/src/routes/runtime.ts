import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { query, queryOne } from "../database";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "@agentandtools/shared";

export const runtimeRoutes = Router();
// M35.1 — hard flip: every runtime route (distill, candidate review) now
// requires a valid JWT. Previously `optionalAuth` silently passed unauth'd
// requests through, which let any caller drive the learning pipeline.
runtimeRoutes.use(requireAuth);

// GET /api/v1/agents/runtime-profile?capability_id=&agent_id=
runtimeRoutes.get("/agents/runtime-profile", async (req: Request, res: Response) => {
  const { capability_id, agent_id } = req.query as Record<string, string>;
  if (!capability_id || !agent_id) throw new AppError("capability_id and agent_id are required");

  const agent = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent.agents WHERE capability_id=$1 AND agent_id=$2 AND status='active'",
    [capability_id, agent_id]
  );
  if (!agent) throw new AppError("No active agent found for given capability and agent_id", 404);

  const uid = agent.agent_uid as string;

  const activeVersion = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent.agent_versions WHERE agent_uid=$1 AND status='active'",
    [uid]
  );
  if (!activeVersion) throw new AppError("No active version for this agent", 404);

  const learningProfile = await queryOne<Record<string, unknown>>(
    `SELECT profile_type, version, summary_text
     FROM agent.agent_learning_profiles
     WHERE agent_uid=$1 AND status='active'
     ORDER BY version DESC LIMIT 1`,
    [uid]
  );

  const profileHash = createHash("sha256")
    .update(`${uid}-${activeVersion.version}-${learningProfile?.version ?? 0}`)
    .digest("hex");

  res.json({
    capability_id,
    agent_id,
    agent_key: agent.agent_key,
    agent_uid: uid,
    active_agent_version: activeVersion.version,
    system_prompt: activeVersion.system_prompt,
    behavior_policy: activeVersion.behavior_policy,
    model_policy: activeVersion.model_policy,
    context_policy: activeVersion.context_policy,
    tool_policy: activeVersion.tool_policy,
    learning_profile: learningProfile ?? null,
    runtime_profile_hash: `sha256:${profileHash}`,
  });
});

// POST /api/v1/learning-candidates
runtimeRoutes.post("/learning-candidates", async (req: Request, res: Response) => {
  const { capability_id, agent_id, agent_uid, source_type, source_id, session_id, candidates } = req.body;

  if (!capability_id || !agent_id || !agent_uid || !source_type || !candidates?.length) {
    throw new AppError("capability_id, agent_id, agent_uid, source_type, and candidates are required");
  }

  const agent = await queryOne("SELECT id FROM agent.agents WHERE agent_uid=$1", [agent_uid]);
  if (!agent) throw new AppError("Agent not found", 404);

  const inserted = [];
  for (const c of candidates) {
    const [row] = await query(
      `INSERT INTO agent.learning_candidates
         (agent_uid, capability_id, agent_id, source_type, source_id, session_id, candidate_type, content, confidence, importance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        agent_uid, capability_id, agent_id, source_type,
        source_id ?? null, session_id ?? null,
        c.candidate_type, c.content,
        c.confidence ?? 0.80, c.importance ?? 0.50,
      ]
    );
    inserted.push(row);
  }

  res.status(201).json({ submitted: inserted.length, candidates: inserted });
});

// GET /api/v1/learning-candidates?agent_uid=&status=
runtimeRoutes.get("/learning-candidates", async (req: Request, res: Response) => {
  const { agent_uid, status } = req.query;
  let sql = "SELECT * FROM agent.learning_candidates WHERE 1=1";
  const params: unknown[] = [];

  if (agent_uid) { params.push(agent_uid); sql += ` AND agent_uid=$${params.length}`; }
  if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
  sql += " ORDER BY created_at DESC LIMIT 100";

  const candidates = await query(sql, params);
  res.json({ candidates });
});

// POST /api/v1/learning-candidates/:id/review
runtimeRoutes.post("/learning-candidates/:id/review", async (req: Request, res: Response) => {
  const { decision, review_note } = req.body;
  if (!["accepted", "rejected"].includes(decision)) throw new AppError("decision must be accepted or rejected");

  const [candidate] = await query(
    `UPDATE agent.learning_candidates
     SET status=$1, reviewed_by=$2, reviewed_at=now()
     WHERE id=$3 RETURNING *`,
    [decision, req.user?.user_id ?? null, req.params.id]
  );
  if (!candidate) throw new AppError("Candidate not found", 404);

  res.json({ ...candidate, review_note });
});

// ─────────────────────────────────────────────────────────────────────────────
// M14 — distillation worker
//
// POST /api/v1/learning-candidates/distill
//   { capability_id, agent_uid, candidate_type, candidate_ids[] }
//
// Looks up the named accepted candidates, batches their content, asks the
// MCP loop to synthesize 1-3 distilled memory rules through the central
// LLM gateway, writes
// DistilledMemory rows the prompt-composer auto-pulls, and marks the
// originating candidates as `distilled`.
//
// M33 — one-shot LLM synthesis goes through the central LLM gateway
// (/v1/chat/completions). The MCP agent loop is not used for pure
// synthesis. Provider keys never live in agent-service.
// ─────────────────────────────────────────────────────────────────────────────

const LLM_GATEWAY_URL    = process.env.LLM_GATEWAY_URL    ?? "http://llm-gateway:8001";
const LLM_GATEWAY_BEARER = process.env.LLM_GATEWAY_BEARER ?? "";
const DISTILL_MODEL_ALIAS = process.env.DISTILL_MODEL_ALIAS?.trim();

interface DistilledMemoryEntry {
  title: string;
  content: string;
  confidence?: number;
}

async function synthesiseCandidates(args: {
  capabilityId: string;
  agentUid: string;
  candidateType: string;
  candidates: Array<{ id: string; content: string; confidence?: number }>;
  traceId: string;
}): Promise<DistilledMemoryEntry[]> {
  // M36.4 — distillation system prompt now lives in prompt-composer
  // (SystemPrompt key "agent-service.distillation"). Edit + re-seed to change.
  const { getSystemPrompt } = await import("@agentandtools/shared");
  const { content: systemPrompt } = await getSystemPrompt("agent-service.distillation");
  const userMessage = [
    `capability_id: ${args.capabilityId}`,
    `agent_uid: ${args.agentUid}`,
    `candidate_type: ${args.candidateType}`,
    "",
    "Observations:",
    ...args.candidates.map((c, i) => `${i + 1}. ${c.content.slice(0, 400)}`),
  ].join("\n");

  const body = {
    ...(DISTILL_MODEL_ALIAS ? { model_alias: DISTILL_MODEL_ALIAS } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage },
    ],
    temperature: 0,
    max_output_tokens: 1500,
    trace_id: args.traceId,
    capability_id: args.capabilityId,
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${LLM_GATEWAY_BEARER}`;
  const res = await fetch(`${LLM_GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new AppError(`Distillation LLM_GATEWAY_UPSTREAM (${res.status}): ${detail}`, 502);
  }
  const data = (await res.json()) as { content?: string };
  const raw = data.content ?? "";

  // Synthetic fallback used when the LLM returns no parseable JSON (mock
  // provider, malformed reply, etc). Joins observations into one rule so the
  // operator still gets a writable row to refine manually.
  const synthetic: DistilledMemoryEntry[] = [{
    title: `${args.candidateType} (${args.candidates.length} observations)`,
    content: args.candidates.map((c) => c.content).join("\n---\n").slice(0, 600),
    confidence: Math.min(...args.candidates.map((c) => c.confidence ?? 0.5)),
  }];

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return synthetic;

  try {
    const parsed = JSON.parse(match[0]) as DistilledMemoryEntry[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty array");
    const cleaned = parsed.slice(0, 3).map((e) => ({
      title: String(e.title ?? "").slice(0, 200),
      content: String(e.content ?? "").slice(0, 2000),
      confidence: typeof e.confidence === "number" ? e.confidence : 0.7,
    })).filter((e) => e.title && e.content);
    return cleaned.length > 0 ? cleaned : synthetic;
  } catch {
    // Bad JSON (mock provider's "[mock] ..." text matches the bracket regex
    // but isn't valid JSON). Fall back gracefully.
    return synthetic;
  }
}

runtimeRoutes.post("/learning-candidates/distill", async (req: Request, res: Response) => {
  const { capability_id, agent_uid, candidate_type, candidate_ids } = req.body ?? {};
  if (!capability_id || !agent_uid || !candidate_type || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
    throw new AppError("capability_id, agent_uid, candidate_type, and candidate_ids[] are required");
  }

  // Load + validate candidates
  const cands = await query<{ id: string; content: string; status: string; confidence: number | null; candidate_type: string }>(
    `SELECT id, content, status, confidence, candidate_type
     FROM agent.learning_candidates
     WHERE id = ANY($1::uuid[])`,
    [candidate_ids],
  );
  if (cands.length !== candidate_ids.length) {
    throw new AppError(`Some candidates not found (got ${cands.length}/${candidate_ids.length})`, 404);
  }
  const wrong = cands.filter((c) => c.status !== "accepted" || c.candidate_type !== candidate_type);
  if (wrong.length > 0) {
    throw new AppError(
      `All candidates must have status='accepted' and candidate_type='${candidate_type}'. ${wrong.length} mismatch.`,
      400,
    );
  }

  const traceId = `distill-${createHash("sha256").update(candidate_ids.join(",")).digest("hex").slice(0, 12)}`;
  const entries = await synthesiseCandidates({
    capabilityId: capability_id,
    agentUid: agent_uid,
    candidateType: candidate_type,
    candidates: cands.map((c) => ({ id: c.id, content: c.content, confidence: c.confidence ?? undefined })),
    traceId,
  });

  // Write DistilledMemory rows (Prisma table; raw SQL because agent-service
  // doesn't have the prisma client wired). Must quote camelCase column names.
  // M15 — embed each entry's title+content + UPDATE the pgvector column so
  // composer's hybrid retrieval can find it. Embedding failures don't abort
  // the row write; the entry just won't surface via semantic search.
  const embedder = getEmbeddingProvider();
  const written: Array<Record<string, unknown>> = [];
  let embeddingFailures = 0;
  for (const e of entries) {
    const [row] = await query<Record<string, unknown>>(
      `INSERT INTO public."DistilledMemory"
         (id, "scopeType", "scopeId", "memoryType", title, content,
          "sourceExecutionIds", confidence, status, version, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'CAPABILITY', $1, $2, $3, $4, $5::jsonb, $6, 'ACTIVE', 1, now(), now())
       RETURNING *`,
      [capability_id, candidate_type, e.title, e.content, JSON.stringify(candidate_ids), e.confidence ?? 0.7],
    );
    try {
      const reused = await query<Record<string, unknown>>(
        `UPDATE public."DistilledMemory" target
         SET embedding = source.embedding
         FROM (
           SELECT embedding FROM public."DistilledMemory"
           WHERE "scopeType" = 'CAPABILITY'
             AND "scopeId" = $1
             AND "memoryType" = $2
             AND title = $3
             AND content = $4
             AND id <> $5
             AND embedding IS NOT NULL
           ORDER BY "createdAt" DESC
           LIMIT 1
         ) source
         WHERE target.id = $5
         RETURNING target.id`,
        [capability_id, candidate_type, e.title, e.content, row.id],
      );
      if (reused.length > 0) {
        written.push(row);
        continue;
      }
      const embedded = await embedder.embed({ text: `${e.title}\n${e.content}`.slice(0, 8_000) });
      assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
      await query(
        `UPDATE public."DistilledMemory" SET embedding = $1::vector WHERE id = $2`,
        [toVectorLiteral(embedded.vector), row.id],
      );
    } catch (err) {
      embeddingFailures += 1;
      // eslint-disable-next-line no-console
      console.warn(`[distill] embedding failed for memory ${row.id}: ${(err as Error).message}`);
    }
    written.push(row);
  }
  void embeddingFailures; // surfaced via logs; not in response shape v0
  void REQUIRED_EMBEDDING_DIM;

  // Mark candidates distilled (preserve `accepted` audit by adding a new status).
  await query(
    `UPDATE agent.learning_candidates
     SET status='distilled', reviewed_at=now()
     WHERE id = ANY($1::uuid[])`,
    [candidate_ids],
  );

  res.status(201).json({
    written: written.length,
    distilled_memory: written,
    candidate_ids,
    capability_id,
    agent_uid,
    candidate_type,
    traceId,
  });
});
