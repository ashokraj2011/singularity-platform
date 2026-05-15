// M30 — `prisma` writes composer-OWNED tables on `singularity_composer`;
// `runtimeReader` reads agent-runtime models on `singularity`.
import { prisma, runtimeReader } from "../../config/prisma";
import { logger } from "../../config/logger";
import { NotFoundError } from "../../shared/errors";
import { sha256, estimateTokens } from "../../shared/hash";
import { render as renderMustache } from "../../shared/mustache";
import { toolServiceClient, DiscoveredTool } from "../../clients/tool-service.client";
import { contextFabricClient } from "../../clients/context-fabric.client";
import { ComposeInput, ArtifactInput } from "./compose.schemas";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "@agentandtools/shared";
import {
  type RetrievedChunk, makeCitationKey, toExcerpt, formatCiteMarker,
  clampConfidence, includeCodeContext, recencyBoost as recencyBoostShared,
  reciprocalRankFusion, retrievalMode, taskSignature,
} from "./retrieval";
import { compileCapsuleViaLlm, compileMode } from "./llm-capsule-compiler";
import {
  tryAcquireCompileSlot, releaseCompileSlot, capsuleExpiry,
  recordCompileAttempt, scheduleCompileRetry,
} from "./capsule-gc";
import { emitAuditEvent } from "../../lib/audit-gov-emit";

// M15 — hybrid scoring helper. Cosine ∈ [-1, 1] → [0, 2] via (cos+1)/2 only
// when the caller asks; default keeps raw cosine because pgvector's `<=>`
// returns 1-cosine (a distance), not similarity. We compute similarity as
// `1 - distance` in the SQL query.
const RECENCY_BOOST_DAYS = Number(process.env.EMBEDDING_RECENCY_DAYS ?? 30);
const RECENCY_BOOST_MAX = Number(process.env.EMBEDDING_RECENCY_BOOST ?? 0.2);

function recencyBoost(ageDays: number): number {
  if (ageDays >= RECENCY_BOOST_DAYS) return 0;
  if (ageDays <= 0) return RECENCY_BOOST_MAX;
  return ((RECENCY_BOOST_DAYS - ageDays) / RECENCY_BOOST_DAYS) * RECENCY_BOOST_MAX;
}

// M25.6 H3 — when both vector AND FTS return only useless rows we'd be
// shipping noise to the LLM (cosine 0.02 matches against an unrelated
// artifact). The threshold is conservative — at 0.2 we're saying "even
// the LEAST-bad row is below half-faith"; the fallback then pulls the
// 3 most-recent rows so the agent has *some* context but isn't pretending
// it found a semantic match.
const EMPTY_FALLBACK_COSINE_MIN = Number(process.env.RETRIEVAL_EMPTY_COSINE_THRESHOLD ?? 0.2);
const EMPTY_FALLBACK_ENABLED    = (process.env.RETRIEVAL_EMPTY_FALLBACK ?? "true").toLowerCase() !== "false";
const EMPTY_FALLBACK_TOPK       = 3;

function noMeaningfulHits<S extends { cosineSimilarity: number; fts_score?: number }>(rows: S[]): boolean {
  if (rows.length === 0) return true;
  return rows.every(r =>
    (r.cosineSimilarity ?? 0) < EMPTY_FALLBACK_COSINE_MIN &&
    ((r.fts_score ?? 0) <= 0)
  );
}

interface SemanticHit {
  cosineSimilarity: number;
  ageDays: number;
  finalScore: number;
}
function rerankByHybrid<T extends SemanticHit>(rows: T[], take: number): T[] {
  for (const r of rows) r.finalScore = r.cosineSimilarity * (1 + recencyBoost(r.ageDays));
  rows.sort((a, b) => b.finalScore - a.finalScore);
  return rows.slice(0, take);
}

// M25.6 — Reciprocal Rank Fusion of vector + FTS results. Each branch
// independently ranks; RRF merges by 1/(k+rank) summed across appearances.
// Then the recency boost is applied to the fused score and the top-N is
// returned. Caller's shape() builds the final row from the raw DB row.
function fuseAndRerank<R extends { id: string }, S extends { cosineSimilarity: number; ageDays: number; fts_score?: number }>(
  vectorRows: R[],
  ftsRows:    R[],
  take:       number,
  shape:      (row: R) => S,
): Array<S & { finalScore: number; rrf_rank: number | null }> {
  if (vectorRows.length === 0 && ftsRows.length === 0) return [];
  if (ftsRows.length === 0) {
    const shaped = vectorRows.map(r => ({ ...shape(r), finalScore: 0, rrf_rank: null as number | null }));
    return rerankByHybrid(shaped, take);
  }
  const fused = reciprocalRankFusion(
    vectorRows.map(r => ({ id: r.id, row: r })),
    ftsRows.map(r => ({ id: r.id, row: r })),
  );
  const shaped = fused.map((f, i) => {
    const base = shape(f.row as R);
    return {
      ...base,
      finalScore: f.rrf_score * (1 + recencyBoost(base.ageDays)),
      rrf_rank:   i + 1 as number | null,
    };
  });
  shaped.sort((a, b) => b.finalScore - a.finalScore);
  return shaped.slice(0, take);
}

interface AssembledLayer {
  promptLayerId?: string;
  promptLayerName?: string;
  layerType: string;
  priority: number;
  inclusionReason: string;
  contentSnapshot: string;
  layerHash: string;
  isRequired?: boolean;
}

type MissingRequiredContext = {
  layerType: string;
  promptLayerId?: string;
  promptLayerName?: string;
  reason: string;
  suggestedFix: string;
};

type ContextPlan = {
  task: string;
  requiredLayers: Array<{
    layerType: string;
    promptLayerId?: string;
    promptLayerName?: string;
    present: boolean;
    mandatoryRuntime: boolean;
  }>;
  selectedLayers: Array<{
    layerType: string;
    promptLayerId?: string;
    promptLayerName?: string;
    priority: number;
    layerHash: string;
    tokenEstimate: number;
    required: boolean;
    inclusionReason: string;
  }>;
  retrievedKnowledge: Array<Record<string, unknown>>;
  retrievedMemory: Array<Record<string, unknown>>;
  retrievedCode: Array<Record<string, unknown>>;
  toolContracts: Array<Record<string, unknown>>;
  excludedContext: Array<Record<string, unknown>>;
  budgetDecision: Record<string, unknown>;
  riskDecision: Record<string, unknown>;
  valid: boolean;
  missingRequired: MissingRequiredContext[];
  contextPlanHash: string;
};

const PRIORITY = {
  PLATFORM: 10,
  AGENT_ROLE: 100,
  CAPABILITY_CONTEXT: 200,
  RUNTIME_EVIDENCE: 250,
  MEMORY_CONTEXT: 300,
  CODE_CONTEXT: 320, // M14 — between MEMORY_CONTEXT and WORKFLOW_PHASE_BASE
  WORKFLOW_PHASE_BASE: 350,
  TOOL_CONTRACT: 500,
  ARTIFACT_CONTEXT: 600,
  TASK_CONTEXT: 900,
  EXECUTION_OVERRIDE: 9999,
};

const DEFAULT_CONTEXT_BUDGET = {
  knowledgeTopK: 5,
  memoryTopK: 3,
  codeTopK: 5,
  maxLayerChars: 2_500,
  maxPromptChars: 48_000,
};

const MANDATORY_RUNTIME_LAYERS = ["PLATFORM_CONSTITUTION", "AGENT_ROLE", "TASK_CONTEXT"];

function clampInt(value: unknown, fallback: number, min = 0, max = 100_000): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n...[trimmed to ${maxChars} chars by token budget]`;
}

function contextBudget(input: ComposeInput) {
  const policy = input.contextPolicy ?? {};
  return {
    knowledgeTopK: clampInt(policy.knowledgeTopK, DEFAULT_CONTEXT_BUDGET.knowledgeTopK, 0, 50),
    memoryTopK: clampInt(policy.memoryTopK, DEFAULT_CONTEXT_BUDGET.memoryTopK, 0, 50),
    codeTopK: clampInt(policy.codeTopK, DEFAULT_CONTEXT_BUDGET.codeTopK, 0, 50),
    maxLayerChars: clampInt(policy.maxLayerChars, DEFAULT_CONTEXT_BUDGET.maxLayerChars, 500, 100_000),
    maxPromptChars: clampInt(policy.maxPromptChars, DEFAULT_CONTEXT_BUDGET.maxPromptChars, 2_000, 500_000),
  };
}

function compactRetrievedChunk(c: RetrievedChunk): Record<string, unknown> {
  return {
    source_kind: c.source_kind,
    source_id: c.source_id,
    citation_key: c.citation_key,
    confidence: c.confidence,
    rrf_rank: c.rrf_rank ?? null,
    excerpt_chars: c.excerpt.length,
    metadata: c.metadata ?? {},
  };
}

function buildContextPlan(args: {
  task: string;
  layers: AssembledLayer[];
  evidenceChunks: RetrievedChunk[];
  budget: ReturnType<typeof contextBudget>;
  budgetWarnings: string[];
  retrievalStats: Record<string, unknown>;
  estimatedInputTokens: number;
  finalPromptHash: string;
}): ContextPlan {
  const selectedLayers = args.layers.map((l) => ({
    layerType: l.layerType,
    promptLayerId: l.promptLayerId,
    promptLayerName: l.promptLayerName,
    priority: l.priority,
    layerHash: l.layerHash,
    tokenEstimate: estimateTokens(l.contentSnapshot),
    required: Boolean(l.isRequired) || MANDATORY_RUNTIME_LAYERS.includes(l.layerType),
    inclusionReason: l.inclusionReason,
  }));

  const requiredLayers: ContextPlan["requiredLayers"] = [];
  const missingRequired: MissingRequiredContext[] = [];
  for (const layerType of MANDATORY_RUNTIME_LAYERS) {
    const present = selectedLayers.some(l => l.layerType === layerType);
    requiredLayers.push({ layerType, present, mandatoryRuntime: true });
    if (!present) {
      missingRequired.push({
        layerType,
        reason: "Mandatory runtime layer was not selected for this prompt assembly.",
        suggestedFix: `Attach or enable a ${layerType} PromptLayer in the agent's prompt profile, or ensure the runtime can render it.`,
      });
    }
  }

  for (const l of args.layers.filter(layer => layer.isRequired)) {
    requiredLayers.push({
      layerType: l.layerType,
      promptLayerId: l.promptLayerId,
      promptLayerName: l.promptLayerName,
      present: Boolean(l.contentSnapshot.trim()),
      mandatoryRuntime: false,
    });
    if (!l.contentSnapshot.trim()) {
      missingRequired.push({
        layerType: l.layerType,
        promptLayerId: l.promptLayerId,
        promptLayerName: l.promptLayerName,
        reason: "Required prompt layer rendered empty content.",
        suggestedFix: "Check the layer template variables and the caller's workflow context.",
      });
    }
  }

  const retrievedKnowledge = args.evidenceChunks.filter(c => c.source_kind === "knowledge").map(compactRetrievedChunk);
  const retrievedMemory = args.evidenceChunks.filter(c => c.source_kind === "memory").map(compactRetrievedChunk);
  const retrievedCode = args.evidenceChunks.filter(c => c.source_kind === "symbol").map(compactRetrievedChunk);
  const toolLayers = args.layers.filter(l => l.layerType === "TOOL_CONTRACT");

  const excludedContext: Array<Record<string, unknown>> = args.budgetWarnings.map((warning) => ({
    reason: "budget_warning",
    warning,
  }));
  if (args.retrievalStats.codeContextSkipped) {
    excludedContext.push({ reason: "code_context_disabled", layerType: "CODE_CONTEXT" });
  }
  if (Number(args.retrievalStats.trimmedLayers ?? 0) > 0) {
    excludedContext.push({ reason: "layer_trimmed", count: args.retrievalStats.trimmedLayers });
  }

  const planWithoutHash = {
    task: args.task,
    requiredLayers,
    selectedLayers,
    retrievedKnowledge,
    retrievedMemory,
    retrievedCode,
    toolContracts: toolLayers.map(l => ({
      layerHash: l.layerHash,
      tokenEstimate: estimateTokens(l.contentSnapshot),
      compacted: true,
      inclusionReason: l.inclusionReason,
    })),
    excludedContext,
    budgetDecision: {
      estimatedInputTokens: args.estimatedInputTokens,
      maxLayerChars: args.budget.maxLayerChars,
      maxPromptChars: args.budget.maxPromptChars,
      budgetWarnings: args.budgetWarnings,
      retrievalStats: args.retrievalStats,
    },
    riskDecision: {
      status: "pending_runtime_governance",
      requiredContextValid: missingRequired.length === 0,
      toolContractsIncluded: toolLayers.length,
    },
    valid: missingRequired.length === 0,
    missingRequired,
  };
  const contextPlanHash = sha256(JSON.stringify({
    ...planWithoutHash,
    finalPromptHash: args.finalPromptHash,
  }));
  return { ...planWithoutHash, contextPlanHash };
}

function contextPlanEvidence(plan: ContextPlan): RetrievedChunk {
  return {
    source_kind: "artifact",
    source_id: plan.contextPlanHash,
    citation_key: `CTX:${plan.contextPlanHash.slice(0, 10)}`,
    excerpt: `ContextPlan ${plan.valid ? "valid" : "invalid"}; required=${plan.requiredLayers.length}; missing=${plan.missingRequired.map(m => m.layerType).join(",") || "none"}`,
    confidence: plan.valid ? 1 : 0,
    cosine_similarity: 1,
    age_days: 0,
    metadata: {
      kind: "context_plan",
      contextPlanHash: plan.contextPlanHash,
      valid: plan.valid,
      missingRequired: plan.missingRequired,
      requiredLayers: plan.requiredLayers,
      selectedLayerCount: plan.selectedLayers.length,
      budgetDecision: plan.budgetDecision,
      riskDecision: plan.riskDecision,
    },
  };
}

export const composeService = {
  /**
   * Full pipeline: assemble layered prompt → call context-fabric /execute → return unified response.
   * If previewOnly is true, skip the LLM call and return the assembled package.
   */
  async composeAndRespond(input: ComposeInput) {
    const layers: AssembledLayer[] = [];
    const warnings: string[] = [];
    const budget = contextBudget(input);
    // M25 — typed retrieval chunks collected as layers are assembled. Mirrored
    // into PromptAssembly.evidenceRefs at the end so Run Insights can show
    // per-step citations and the LLM can ground its answers via 〔cite: …〕.
    const evidenceChunks: RetrievedChunk[] = [];
    // M25.5 — set when a precompiled context capsule was served.
    let compiledCapsule: { id: string; layers: AssembledLayer[]; chunks: RetrievedChunk[] } | null = null;
    const retrievalStats = {
      knowledgeIncluded: 0,
      memoryIncluded: 0,
      codeIncluded: 0,
      toolContractsIncluded: 0,
      trimmedLayers: 0,
      // M25.7 — true when PROMPT_INCLUDE_CODE_CONTEXT=false (default post-M27).
      codeContextSkipped: false as boolean,
      // M25.5 — true when served from CapabilityCompiledContext cache.
      capsuleHit: false as boolean,
      // M25.5 C6 — true when ?nocache=1 / Bypass-Cache / bypassCache:true
      // forced the cold path. Surfaced on the response + audit emit so
      // operators can correlate edits to refreshed retrievals.
      capsuleBypassed: false as boolean,
      // M25.6 H3 — flips to true when at least one retrieval branch fell
      // back to recency-only because both vector + FTS came back empty/weak.
      // Operators reading Run Insights need to see this — "the agent saw
      // 3 unrelated artifacts" is very different from "the agent saw 3
      // semantically-matched artifacts".
      recencyFallback: false as boolean,
    };

    // Build the substitution context once.
    const ctx = await this.buildVarsContext(input);

    // 1. Agent template + base prompt profile
    const template = await runtimeReader.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");
    if (template.basePromptProfileId) {
      layers.push(...await this.loadProfileLayers(template.basePromptProfileId, "agent template base profile", ctx, warnings));
    }

    // 2. Binding overlay
    let binding: { id: string; promptProfileId: string | null; capabilityId: string | null } | null = null;
    if (input.agentBindingId) {
      binding = await runtimeReader.agentCapabilityBinding.findUnique({
        where: { id: input.agentBindingId },
        select: { id: true, promptProfileId: true, capabilityId: true },
      });
      if (binding?.promptProfileId) {
        layers.push(...await this.loadProfileLayers(binding.promptProfileId, "agent binding overlay", ctx, warnings));
      }
    }

    // 3. Capability context, knowledge, distilled memory, code context
    const capabilityId = input.capabilityId ?? binding?.capabilityId ?? null;
    if (capabilityId) {
      const capability = await runtimeReader.capability.findUnique({ where: { id: capabilityId } });
      if (capability) {
        const capContent = `Capability: ${capability.name}\nType: ${capability.capabilityType ?? "—"}\nCriticality: ${capability.criticality ?? "—"}\n${capability.description ?? ""}`;
        const r = renderMustache(capContent, ctx); warnings.push(...r.warnings);
        layers.push({ layerType: "CAPABILITY_CONTEXT", priority: PRIORITY.CAPABILITY_CONTEXT, inclusionReason: "capability scope provided", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });

        // ── M25.5 — Context Compiler cache lookup ──────────────────────────
        // Skip the 3 semantic queries + reranking when a precompiled capsule
        // matches this (capability, agentTemplate, intent, contentRevision).
        // Hot path: serve the cached layers + chunks directly.
        //
        // M25.5 C6 — when the caller asked for a bypass (operator editing
        // knowledge, debugging, regression-testing) we skip the lookup
        // entirely. We still let the cold path run + store a fresh capsule
        // below unless bypassCache is set, which suppresses that too.
        if (input.bypassCache) {
          retrievalStats.capsuleBypassed = true;
        } else {
          compiledCapsule = await this.lookupCapsule({
            capabilityId,
            agentTemplateId: input.agentTemplateId,
            intent: input.task,
          });
        }
        if (compiledCapsule) {
          retrievalStats.capsuleHit = true;
          // Replay the capsule's cached layers + chunks. We trust the capsule
          // hash discipline (taskSignature) to make stale serves impossible.
          const cachedLayers = compiledCapsule.layers as AssembledLayer[];
          for (const cl of cachedLayers) {
            layers.push({
              ...cl,
              inclusionReason: `${cl.inclusionReason} (capsule)`,
            });
          }
          const cachedChunks = compiledCapsule.chunks as RetrievedChunk[];
          for (const c of cachedChunks) evidenceChunks.push(c);
          retrievalStats.knowledgeIncluded = cachedChunks.filter(c => c.source_kind === "knowledge").length;
          retrievalStats.memoryIncluded    = cachedChunks.filter(c => c.source_kind === "memory").length;
          // Increment hitCount in the background — don't block compose.
          void prisma.capabilityCompiledContext.update({
            where: { id: compiledCapsule.id },
            data: { hitCount: { increment: 1 } },
          }).catch(() => { /* best-effort */ });
        }

        // M15 — embed the task once; reuse for all three retrieval queries.
        // Failure falls back to createdAt ordering so retrieval never blocks
        // composition. Skipped entirely on capsule hit.
        let taskVec: string | null = null;
        if (!compiledCapsule) {
          try {
            if (input.task && input.task.trim().length > 0) {
              const embedded = await getEmbeddingProvider().embed({ text: input.task.slice(0, 8_000) });
              assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
              taskVec = toVectorLiteral(embedded.vector);
            }
          } catch (err) {
            warnings.push(`embedding failed: ${(err as Error).message}`);
          }
        }
        // Skip the entire retrieval block on capsule hit.
        if (compiledCapsule) {
          // jump to step 4 (workflow phase) — Function-level early-out is awkward
          // inside the if-block, so use a flag the existing block checks.
        }

      if (!compiledCapsule) {
        // ── Knowledge artifacts → RUNTIME_EVIDENCE ──────────────────────────
        const artifacts = budget.knowledgeTopK === 0 ? [] : taskVec
          ? await this.semanticKnowledge(capabilityId, taskVec, budget.knowledgeTopK, input.task)
          : (await runtimeReader.capabilityKnowledgeArtifact.findMany({ where: { capabilityId, status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: budget.knowledgeTopK }))
            .map(a => ({ ...a, cosineSimilarity: 0, ageDays: 0, finalScore: 0, fts_score: 0, rrf_rank: null as number | null }));
        for (const a of artifacts) {
          const citation = makeCitationKey("knowledge", a.title, a.id);
          const fallback = (a as { fallbackKind?: string }).fallbackKind;
          if (fallback === "recency_only") retrievalStats.recencyFallback = true;
          const chunk: RetrievedChunk = {
            source_kind: "knowledge",
            source_id: a.id,
            citation_key: citation,
            excerpt: toExcerpt(a.content),
            confidence: clampConfidence((a as { finalScore?: number }).finalScore ?? 0),
            cosine_similarity: a.cosineSimilarity,
            fts_score: (a as { fts_score?: number }).fts_score,
            rrf_rank: (a as { rrf_rank?: number | null }).rrf_rank ?? undefined,
            age_days: a.ageDays,
            metadata: {
              artifactType: a.artifactType,
              capabilityId,
              version: 1,
              ...(fallback ? { fallbackKind: fallback } : {}),
            },
          };
          evidenceChunks.push(chunk);
          // M25 — cite marker BEFORE the body, so the LLM can echo it in
          // its output and operators can trace each claim back to a source.
          const c = `${formatCiteMarker(citation)}\n[${a.artifactType}] ${a.title}\n${trimText(a.content, budget.maxLayerChars)}`;
          const r2 = renderMustache(c, ctx); warnings.push(...r2.warnings);
          if (a.content.length > budget.maxLayerChars) retrievalStats.trimmedLayers += 1;
          layers.push({
            layerType: "RUNTIME_EVIDENCE",
            priority: PRIORITY.RUNTIME_EVIDENCE,
            inclusionReason: taskVec
              ? `knowledge ${a.artifactType} (cos=${a.cosineSimilarity.toFixed(3)}, age=${a.ageDays.toFixed(1)}d)`
              : `knowledge artifact ${a.artifactType}`,
            contentSnapshot: r2.rendered,
            layerHash: sha256(r2.rendered),
          });
          retrievalStats.knowledgeIncluded += 1;
        }

        // ── Distilled memory → MEMORY_CONTEXT ──────────────────────────────
        const memory = budget.memoryTopK === 0 ? [] : taskVec
          ? await this.semanticMemory(capabilityId, taskVec, budget.memoryTopK, input.task)
          : (await runtimeReader.distilledMemory.findMany({ where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: budget.memoryTopK }))
            .map(m => ({ ...m, cosineSimilarity: 0, ageDays: 0, finalScore: 0, fts_score: 0, rrf_rank: null as number | null }));
        for (const m of memory) {
          const citation = makeCitationKey("memory", m.title, m.id);
          const fallback = (m as { fallbackKind?: string }).fallbackKind;
          if (fallback === "recency_only") retrievalStats.recencyFallback = true;
          const chunk: RetrievedChunk = {
            source_kind: "memory",
            source_id: m.id,
            citation_key: citation,
            excerpt: toExcerpt(m.content),
            confidence: clampConfidence((m as { finalScore?: number }).finalScore ?? 0),
            cosine_similarity: m.cosineSimilarity,
            fts_score: (m as { fts_score?: number }).fts_score,
            rrf_rank: (m as { rrf_rank?: number | null }).rrf_rank ?? undefined,
            age_days: m.ageDays,
            metadata: {
              memoryType: m.memoryType,
              capabilityId,
              ...(fallback ? { fallbackKind: fallback } : {}),
            },
          };
          evidenceChunks.push(chunk);
          const c = `${formatCiteMarker(citation)}\n[${m.memoryType}] ${m.title}\n${trimText(m.content, budget.maxLayerChars)}`;
          const r3 = renderMustache(c, ctx); warnings.push(...r3.warnings);
          if (m.content.length > budget.maxLayerChars) retrievalStats.trimmedLayers += 1;
          layers.push({
            layerType: "MEMORY_CONTEXT",
            priority: PRIORITY.MEMORY_CONTEXT,
            inclusionReason: taskVec
              ? `distilled memory (cos=${m.cosineSimilarity.toFixed(3)}, age=${m.ageDays.toFixed(1)}d)`
              : "distilled memory match",
            contentSnapshot: r3.rendered,
            layerHash: sha256(r3.rendered),
          });
          retrievalStats.memoryIncluded += 1;
        }

        // ── Code symbols → CODE_CONTEXT ────────────────────────────────────
        // M25.7 / M27 — opt-in. Code symbols now live in mcp-server's local
        // AST index (wherever mcp-server runs — laptop, VPC, dev host); the
        // agent fetches them via tool calls (find_symbol / get_symbol /
        // get_ast_slice) instead of paying tokens for top-N on every prompt.
        // Set PROMPT_INCLUDE_CODE_CONTEXT=true to bring back the legacy
        // behaviour for capabilities that pre-date M27.
        if (includeCodeContext()) {
          const symbols = budget.codeTopK === 0 ? [] : taskVec
            ? await this.semanticSymbols(capabilityId, taskVec, budget.codeTopK)
            : (await runtimeReader.capabilityCodeSymbol.findMany({
              where: { capabilityId }, orderBy: { createdAt: "desc" }, take: budget.codeTopK,
              include: { repository: true },
            })).map(s => ({
              symbol_id: s.id, symbolName: s.symbolName, symbolType: s.symbolType,
              filePath: s.filePath, startLine: s.startLine, summary: s.summary,
              language: s.language, repoName: s.repository?.repoName ?? "repo",
              cosineSimilarity: 0, ageDays: 0, finalScore: 0,
            }));
          for (const s of symbols) {
            const body = trimText(s.summary ?? `${s.symbolType ?? "symbol"} ${s.symbolName ?? ""}`, budget.maxLayerChars);
            const citation = makeCitationKey("symbol", s.symbolName ?? "symbol", s.symbol_id);
            evidenceChunks.push({
              source_kind: "symbol",
              source_id: s.symbol_id,
              citation_key: citation,
              excerpt: toExcerpt(body),
              confidence: clampConfidence((s as { finalScore?: number }).finalScore ?? 0),
              cosine_similarity: s.cosineSimilarity,
              age_days: s.ageDays,
              metadata: {
                repoName: s.repoName, filePath: s.filePath, startLine: s.startLine,
                symbolType: s.symbolType, language: s.language,
              },
            });
            const c = `${formatCiteMarker(citation)}\n[${s.symbolType ?? "symbol"}] ${s.repoName}/${s.filePath}:${s.startLine ?? "?"}\n${body}`;
            const r4 = renderMustache(c, ctx); warnings.push(...r4.warnings);
            layers.push({
              layerType: "CODE_CONTEXT" as never,
              priority: PRIORITY.CODE_CONTEXT,
              inclusionReason: taskVec
                ? `code ${s.symbolName ?? ""} (cos=${s.cosineSimilarity.toFixed(3)}, age=${s.ageDays.toFixed(1)}d)`
                : `code symbol ${s.symbolName ?? ""} (${s.language ?? ""})`,
              contentSnapshot: r4.rendered,
              layerHash: sha256(r4.rendered),
            });
            if ((s.summary ?? "").length > budget.maxLayerChars) retrievalStats.trimmedLayers += 1;
            retrievalStats.codeIncluded += 1;
          }
        } else {
          // Note in retrievalStats so callers can see we skipped the layer.
          retrievalStats.codeContextSkipped = true;
        }
      } // !compiledCapsule — end of retrieval block
      // M25.5 — on cache miss, fire-and-forget write the capsule so the NEXT
      // request with the same task signature can skip retrieval entirely.
      // M25.5 C6 — when the caller bypassed the cache, also suppress the
      // store. An operator editing content shouldn't accidentally re-seed a
      // capsule from a not-yet-final state of the knowledge base.
      if (!compiledCapsule && !input.bypassCache && evidenceChunks.length > 0) {
        // Only cache layers that came from semantic retrieval (RUNTIME_EVIDENCE
        // / MEMORY_CONTEXT / CODE_CONTEXT). Other layer types are profile- or
        // workflow-scoped and recompute correctly every call.
        const cacheableLayers = layers.filter(l =>
          l.layerType === "RUNTIME_EVIDENCE" ||
          l.layerType === "MEMORY_CONTEXT" ||
          (l.layerType as string) === "CODE_CONTEXT"
        );
        void this.storeCapsule({
          capabilityId,
          agentTemplateId: input.agentTemplateId,
          intent: input.task,
          layers: cacheableLayers,
          chunks: evidenceChunks,
        }).catch((err: Error) => logger.warn({ err: err.message }, "[compose] storeCapsule failed"));
      }
      }
    }

    // 4. Workflow phase layers
    if (input.workflowContext.phaseId) {
      const phaseLayers = await prisma.promptLayer.findMany({ where: { scopeType: "WORKFLOW_PHASE", scopeId: input.workflowContext.phaseId, status: "ACTIVE" } });
      for (const l of phaseLayers) {
        const r = renderMustache(l.content, ctx); warnings.push(...r.warnings);
        layers.push({
          promptLayerId: l.id,
          promptLayerName: l.name,
          layerType: l.layerType,
          priority: PRIORITY.WORKFLOW_PHASE_BASE + l.priority,
          inclusionReason: `workflow phase ${input.workflowContext.phaseId}`,
          contentSnapshot: r.rendered,
          layerHash: l.contentHash ?? sha256(r.rendered),
          isRequired: l.isRequired,
        });
      }
    }

    // 5. Tool contracts — both DB-grant-driven and dynamic discovery
    const toolsLayer = await this.buildToolContractLayer(input, capabilityId, template.id, retrievalStats);
    if (toolsLayer) {
      const r = renderMustache(trimText(toolsLayer, budget.maxLayerChars * 2), ctx); warnings.push(...r.warnings);
      if (toolsLayer.length > budget.maxLayerChars * 2) retrievalStats.trimmedLayers += 1;
      layers.push({ layerType: "TOOL_CONTRACT", priority: PRIORITY.TOOL_CONTRACT, inclusionReason: "tool grants + dynamic discovery", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }

    // 6. Artifact context (workgraph passes consumables)
    for (const art of input.artifacts) {
      const rendered = await this.renderArtifact(art);
      if (!rendered) continue;
      const trimmed = trimText(rendered, budget.maxLayerChars * 2);
      const r = renderMustache(trimmed, ctx); warnings.push(...r.warnings);
      if (rendered.length > trimmed.length) retrievalStats.trimmedLayers += 1;
      layers.push({ layerType: "ARTIFACT_CONTEXT", priority: PRIORITY.ARTIFACT_CONTEXT, inclusionReason: `artifact ${art.label} (${art.role})`, contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }

    // 7. Task context
    const taskRendered = renderMustache(input.task, ctx); warnings.push(...taskRendered.warnings);
    const taskContent = `# Current Task\n${taskRendered.rendered}`;
    layers.push({ layerType: "TASK_CONTEXT", priority: PRIORITY.TASK_CONTEXT, inclusionReason: "user task", contentSnapshot: taskContent, layerHash: sha256(taskContent), isRequired: true });

    // 8. EXECUTION_OVERRIDE layers from request
    for (const ov of input.overrides.additionalLayers) {
      const r = renderMustache(ov.content, ctx); warnings.push(...r.warnings);
      layers.push({ layerType: ov.layerType, priority: PRIORITY.EXECUTION_OVERRIDE, inclusionReason: "node-level override", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }
    if (input.overrides.systemPromptAppend) {
      const r = renderMustache(input.overrides.systemPromptAppend, ctx); warnings.push(...r.warnings);
      layers.push({ layerType: "EXECUTION_OVERRIDE", priority: PRIORITY.EXECUTION_OVERRIDE + 1, inclusionReason: "node-level systemPromptAppend", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }
    if (input.overrides.extraContext) {
      const r = renderMustache(input.overrides.extraContext, ctx); warnings.push(...r.warnings);
      layers.push({ layerType: "EXECUTION_OVERRIDE", priority: PRIORITY.EXECUTION_OVERRIDE + 2, inclusionReason: "node-level extraContext", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }

    // 9. Sort + concat
    layers.sort((a, b) => a.priority - b.priority);
    let finalPrompt = layers.map(l => `# ${humanLayer(l.layerType)}\n${l.contentSnapshot}`).join("\n\n");
    const budgetWarnings: string[] = [];
    if (finalPrompt.length > budget.maxPromptChars) {
      budgetWarnings.push(`Prompt stack trimmed from ${finalPrompt.length} chars to ${budget.maxPromptChars} chars.`);
      finalPrompt = trimText(finalPrompt, budget.maxPromptChars);
    }
    const finalPromptHash = sha256(finalPrompt);
    const estimatedInputTokens = estimateTokens(finalPrompt);
    if (input.contextPolicy.maxContextTokens && estimatedInputTokens > input.contextPolicy.maxContextTokens) {
      budgetWarnings.push(`Estimated input tokens ${estimatedInputTokens} exceeds maxContextTokens ${input.contextPolicy.maxContextTokens}.`);
    }
    const contextPlan = buildContextPlan({
      task: taskRendered.rendered,
      layers,
      evidenceChunks,
      budget,
      budgetWarnings,
      retrievalStats,
      estimatedInputTokens,
      finalPromptHash,
    });
    const evidenceRefs = [contextPlanEvidence(contextPlan), ...evidenceChunks];

    // 10. Persist PromptAssembly, reusing an unchanged stack when possible.
    // The final prompt hash already includes task text, rendered artifacts,
    // layer content, runtime overrides, and retrieved context.
    const cachedAssembly = await prisma.promptAssembly.findFirst({
      where: {
        agentTemplateId: input.agentTemplateId,
        agentBindingId: input.agentBindingId ?? null,
        capabilityId: capabilityId ?? null,
        finalPromptHash,
        modelProvider: input.modelOverrides.provider ?? null,
        modelName: input.modelOverrides.model ?? null,
      },
      orderBy: { createdAt: "desc" },
    });
    // M28 spine-2 — traceId is the run-evidence spine. Prefer the explicit
    // value from the caller; fall back to instanceId so legacy callers keep
    // working until they pass it explicitly.
    const resolvedTraceId =
      (input.workflowContext as { traceId?: string }).traceId ??
      input.workflowContext.instanceId ??
      null;

    const assembly = cachedAssembly ?? await prisma.promptAssembly.create({
      data: {
        agentTemplateId: input.agentTemplateId,
        agentBindingId: input.agentBindingId ?? null,
        capabilityId: capabilityId ?? null,
        workflowExecutionId: input.workflowContext.instanceId,
        promptProfileId: template.basePromptProfileId ?? null,
        modelProvider: input.modelOverrides.provider ?? null,
        modelName: input.modelOverrides.model ?? null,
        finalPromptHash,
        finalPromptPreview: finalPrompt.slice(0, 4000),
        estimatedInputTokens,
        traceId: resolvedTraceId,
        // M25 — per-step citations for Run Insights + audit-replay.
        evidenceRefs: (evidenceRefs.length > 0
          ? evidenceRefs
          : null) as never,
        layers: {
          create: layers.map(l => ({
            promptLayerId: l.promptLayerId ?? null,
            layerType: l.layerType, layerHash: l.layerHash, priority: l.priority,
            included: true, inclusionReason: l.inclusionReason, contentSnapshot: l.contentSnapshot,
          })),
        },
      },
    });
    if (cachedAssembly) {
      budgetWarnings.push(`Prompt assembly reused from cache: ${cachedAssembly.id}.`);
      // Older cached assemblies may predate ContextPlan. Refresh the small
      // evidenceRefs payload so Run Insights can still show the governance
      // contract used for this invocation without creating duplicate rows.
      await prisma.promptAssembly.update({
        where: { id: cachedAssembly.id },
        data: { evidenceRefs: evidenceRefs as never },
      }).catch((err) => logger.warn({ err, promptAssemblyId: cachedAssembly.id }, "failed to refresh cached context plan evidence"));
    }

    const layersUsed = layers.map(l => ({ layerType: l.layerType, priority: l.priority, layerHash: l.layerHash, inclusionReason: l.inclusionReason }));
    const dedupedWarnings = Array.from(new Set([...warnings, ...budgetWarnings]));

    // M22 fan-out — emit prompt-composer's contribution to the central audit
    // ledger. Fire-and-forget; failures are logged at warn but don't block
    // composition.
    emitAuditEvent({
      trace_id:       input.workflowContext.instanceId,
      source_service: "prompt-composer",
      kind:           "prompt.assembly.created",
      subject_type:   "PromptAssembly",
      subject_id:     assembly.id,
      capability_id:  capabilityId ?? undefined,
      severity:       "info",
      payload: {
        agentTemplateId:   input.agentTemplateId,
        agentBindingId:    input.agentBindingId ?? null,
        workflowNodeId:    input.workflowContext.nodeId,
        promptHash:        finalPromptHash,
        estimatedTokens:   assembly.estimatedInputTokens,
        layersUsedCount:   layersUsed.length,
        evidenceCount:     evidenceChunks.length,
        contextPlanHash:   contextPlan.contextPlanHash,
        contextPlanValid:  contextPlan.valid,
        missingRequiredContext: contextPlan.missingRequired,
        retrievalStats,
        previewOnly:       input.previewOnly === true,
        capsuleHit:        retrievalStats.capsuleHit,
        capsuleBypassed:   retrievalStats.capsuleBypassed,
        // First few citation_keys for quick eyeballing in /audit. Full chunks
        // stay in PromptAssembly.evidenceRefs.
        citations: evidenceChunks.slice(0, 6).map(c => c.citation_key),
      },
    });

    if (input.previewOnly) {
      return {
        promptAssemblyId: assembly.id,
        promptHash: finalPromptHash,
        estimatedInputTokens: assembly.estimatedInputTokens,
        layersUsed,
        warnings: dedupedWarnings,
        budgetWarnings,
        retrievalStats,
        assembled: {
          systemPrompt: finalPrompt,
          message: taskRendered.rendered,
        },
        contextPlan,
      };
    }

    // 11. Call context-fabric /execute. Direct /chat/respond is intentionally
    // bypassed so every real LLM-backed agent call uses the governed MCP path.
    const sessionId = `wf:${input.workflowContext.instanceId}:${input.workflowContext.nodeId}`;
    const cfResp = await contextFabricClient.executeRespond({
      trace_id: input.workflowContext.instanceId,
      run_context: {
        workflow_instance_id: input.workflowContext.instanceId || sessionId,
        workflow_node_id: input.workflowContext.nodeId || "compose-and-respond",
        capability_id: capabilityId ?? undefined,
      },
      task: taskRendered.rendered,
      system_prompt: finalPrompt,
      model_overrides: {
        modelAlias: input.modelOverrides.modelAlias,
        provider: input.modelOverrides.provider,
        model: input.modelOverrides.model,
        temperature: input.modelOverrides.temperature,
        maxOutputTokens: input.modelOverrides.maxOutputTokens,
      },
      context_policy: input.contextPolicy.optimizationMode || input.contextPolicy.maxContextTokens || input.contextPolicy.compareWithRaw !== undefined ? {
        optimization_mode: input.contextPolicy.optimizationMode,
        max_context_tokens: input.contextPolicy.maxContextTokens,
        compare_with_raw: input.contextPolicy.compareWithRaw,
      } : undefined,
      limits: {
        outputTokenBudget: input.modelOverrides.maxOutputTokens,
      },
    });

    const optimization = cfResp.metrics?.contextOptimization ?? {};
    const modelUsage = cfResp.modelUsage ?? {};
    logger.info({
      promptAssemblyId: assembly.id,
      cfCallId: cfResp.correlation?.cfCallId,
      tokensSaved: optimization.tokens_saved ?? optimization.tokensSaved,
    }, "compose-and-respond complete");

    return {
      promptAssemblyId: assembly.id,
      promptHash: finalPromptHash,
      estimatedInputTokens: assembly.estimatedInputTokens,
      layersUsed,
      warnings: dedupedWarnings,
      budgetWarnings,
      retrievalStats,
      contextPlan,
      modelCallId: cfResp.correlation?.llmCallIds?.[0] ?? cfResp.correlation?.cfCallId,
      contextPackageId: cfResp.correlation?.cfCallId ?? "",
      response: cfResp.finalResponse,
      optimization: {
        mode: input.contextPolicy.optimizationMode ?? "medium",
        raw_input_tokens: Number(optimization.raw_input_tokens ?? optimization.rawInputTokens ?? modelUsage.inputTokens ?? 0),
        optimized_input_tokens: Number(optimization.optimized_input_tokens ?? optimization.optimizedInputTokens ?? modelUsage.inputTokens ?? 0),
        tokens_saved: Number(optimization.tokens_saved ?? optimization.tokensSaved ?? cfResp.usage?.tokensSaved ?? 0),
        percent_saved: Number(optimization.percent_saved ?? optimization.percentSaved ?? 0),
        estimated_raw_cost: Number(optimization.estimated_raw_cost ?? optimization.estimatedRawCost ?? 0),
        estimated_optimized_cost: Number(optimization.estimated_optimized_cost ?? optimization.estimatedOptimizedCost ?? modelUsage.estimatedCost ?? 0),
        estimated_cost_saved: Number(optimization.estimated_cost_saved ?? optimization.estimatedCostSaved ?? 0),
      },
      modelUsage: {
        modelAlias: String(modelUsage.modelAlias ?? cfResp.usage?.modelAlias ?? input.modelOverrides.modelAlias ?? ""),
        provider: String(modelUsage.provider ?? cfResp.usage?.provider ?? input.modelOverrides.provider ?? "unknown"),
        model: String(modelUsage.model ?? cfResp.usage?.model ?? input.modelOverrides.model ?? "unknown"),
        input_tokens: Number(modelUsage.inputTokens ?? cfResp.usage?.inputTokens ?? 0),
        output_tokens: Number(modelUsage.outputTokens ?? cfResp.usage?.outputTokens ?? 0),
        total_tokens: Number(modelUsage.totalTokens ?? cfResp.usage?.totalTokens ?? 0),
        estimated_cost: Number(modelUsage.estimatedCost ?? cfResp.usage?.estimatedCost ?? 0),
        latency_ms: 0,
      },
    };
  },

  async buildVarsContext(input: ComposeInput): Promise<Record<string, unknown>> {
    // Load capability metadata for {{capability.metadata.*}}
    let capabilityMeta: Record<string, unknown> = {};
    const capabilityId = input.capabilityId;
    if (capabilityId) {
      const cap = await runtimeReader.capability.findUnique({ where: { id: capabilityId } });
      if (cap) {
        capabilityMeta = {
          id: cap.id, name: cap.name, capabilityType: cap.capabilityType,
          criticality: cap.criticality, description: cap.description,
        };
      }
    }
    const artifactsByLabel: Record<string, unknown> = {};
    for (const art of input.artifacts) {
      artifactsByLabel[art.label] = {
        label: art.label,
        consumableId: art.consumableId, consumableType: art.consumableType, role: art.role,
        excerpt: art.excerpt ?? art.content ?? "", mediaType: art.mediaType,
      };
    }
    return {
      task: input.task,
      instance: { vars: input.workflowContext.vars, globals: input.workflowContext.globals },
      node: { id: input.workflowContext.nodeId, priorOutputs: input.workflowContext.priorOutputs },
      capability: { metadata: capabilityMeta },
      artifacts: artifactsByLabel,
    };
  },

  async loadProfileLayers(profileId: string, reason: string, ctx: Record<string, unknown>, warnings: string[]): Promise<AssembledLayer[]> {
    const links = await prisma.promptProfileLayer.findMany({
      where: { promptProfileId: profileId, isEnabled: true },
      include: { promptLayer: true },
      orderBy: { priority: "asc" },
    });
    return links
      .filter(l => l.promptLayer.status === "ACTIVE")
      .map(l => {
        const r = renderMustache(l.promptLayer.content, ctx);
        warnings.push(...r.warnings);
        return {
          promptLayerId: l.promptLayer.id,
          promptLayerName: l.promptLayer.name,
          layerType: l.promptLayer.layerType,
          priority: l.priority,
          inclusionReason: reason,
          contentSnapshot: r.rendered,
          layerHash: sha256(r.rendered),
          isRequired: l.promptLayer.isRequired,
        };
      });
  },

  async buildToolContractLayer(input: ComposeInput, capabilityId: string | null, agentTemplateId: string, retrievalStats?: { toolContractsIncluded: number }): Promise<string | null> {
    // Static grants (existing model)
    const scopeFilters: Array<{ grantScopeType: string; grantScopeId: string }> = [
      { grantScopeType: "AGENT_TEMPLATE", grantScopeId: agentTemplateId },
    ];
    if (input.agentBindingId) scopeFilters.push({ grantScopeType: "AGENT_BINDING", grantScopeId: input.agentBindingId });
    if (capabilityId) scopeFilters.push({ grantScopeType: "CAPABILITY", grantScopeId: capabilityId });

    const grants = await runtimeReader.toolGrant.findMany({
      where: { OR: scopeFilters as never, status: "ACTIVE" },
      include: { tool: { include: { contracts: { where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1 } } } },
    });
    const filtered = grants.filter(g => !g.workflowPhase || g.workflowPhase === input.workflowContext.phaseId);

    const blocks: string[] = [];
    for (const g of filtered) {
      const c = g.tool.contracts[0];
      const fullName = `${g.tool.namespace}.${g.tool.name}`;
      blocks.push(this.renderToolBlock({
        tool_name: fullName,
        natural_language: g.tool.description ?? "",
        risk_level: c?.riskLevel ?? "LOW",
        requires_approval: c?.requiresApproval ?? false,
      }));
      if (retrievalStats) retrievalStats.toolContractsIncluded += 1;
    }

    // Dynamic tool discovery via tool-service (only if capability is provided and discovery enabled)
    if (input.toolDiscovery.enabled && capabilityId) {
      const discovered = await toolServiceClient.discover({
        capability_id: capabilityId,
        agent_uid: agentTemplateId,
        agent_id: input.agentBindingId,
        query: input.task,
        risk_max: input.toolDiscovery.riskMax,
        limit: input.toolDiscovery.limit,
      });
      for (const t of discovered) {
        // Skip duplicates already covered by static grants
        if (filtered.some(g => `${g.tool.namespace}.${g.tool.name}` === t.tool_name)) continue;
        blocks.push(this.renderToolBlock({
          tool_name: t.tool_name,
          natural_language: t.description,
          risk_level: t.risk_level,
          requires_approval: false,
        }));
        if (retrievalStats) retrievalStats.toolContractsIncluded += 1;
      }
    }

    if (blocks.length === 0) return null;
    return `Available tools:\n\n${blocks.join("\n\n")}`;
  },

  renderToolBlock(t: {
    tool_name: string;
    natural_language: string;
    risk_level: string;
    requires_approval: boolean;
  }): string {
    return `## Tool: ${t.tool_name}
Description: ${t.natural_language}
Risk: ${t.risk_level}${t.requires_approval ? " (requires approval)" : ""}
Input contract: available to the execution layer; ask for only the fields needed.`;
  },

  async renderArtifact(art: ArtifactInput): Promise<string | null> {
    let body: string | null = null;
    if (art.content) body = art.content;
    else if (art.excerpt) body = art.excerpt;
    else if (art.minioRef) {
      // M4.1: implement MinIO fetch + media-type extraction. For now, log + skip.
      logger.warn({ minioRef: art.minioRef, label: art.label }, "minioRef fetch not yet implemented; skipping artifact body");
      body = `[artifact ${art.label}: stored at ${art.minioRef} — fetch not implemented]`;
    }
    if (!body) return null;
    const header = `## Artifact: ${art.label} (${art.role}${art.consumableType ? `, ${art.consumableType}` : ""})`;
    return `${header}\n${body}`;
  },

  // ── M15 — semantic retrieval helpers (hybrid cosine × recency) ──────────
  //
  // pgvector's `<=>` operator returns cosine **distance** (1 - similarity).
  // We compute similarity in the projection so the ORDER BY uses the
  // index-friendly distance form. Final hybrid score is JS-computed via
  // rerankByHybrid() so we keep the recency-boost math out of SQL.

  // M25.6 — hybrid retrieval. Runs the vector + (optional) FTS query in
  // parallel, fuses with Reciprocal Rank Fusion, then applies the recency
  // boost. Falls back to vector-only when RETRIEVAL_MODE=vector or when the
  // FTS column doesn't yet exist on this DB (older deployments).
  async semanticKnowledge(capabilityId: string, taskVec: string, take = DEFAULT_CONTEXT_BUDGET.knowledgeTopK, taskText?: string) {
    const candidatePool = 30;
    const mode = retrievalMode();
    type Row = {
      id: string; artifactType: string; title: string; content: string;
      cosine_similarity: number; age_days: number;
    };
    const vectorRows = mode === "fts" ? [] : await runtimeReader.$queryRawUnsafe<Row[]>(
      `SELECT id, "artifactType", title, content,
              1 - (embedding <=> $1::vector) AS cosine_similarity,
              EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days
       FROM "CapabilityKnowledgeArtifact"
       WHERE "capabilityId" = $2 AND status = 'ACTIVE' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT ${candidatePool}`,
      taskVec, capabilityId,
    );
    let ftsRows: Array<Row & { fts_score: number }> = [];
    if (mode !== "vector" && taskText && taskText.trim().length > 0) {
      try {
        ftsRows = await runtimeReader.$queryRawUnsafe<Array<Row & { fts_score: number }>>(
          `SELECT id, "artifactType", title, content,
                  0::float AS cosine_similarity,
                  EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days,
                  ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS fts_score
           FROM "CapabilityKnowledgeArtifact"
           WHERE "capabilityId" = $2 AND status = 'ACTIVE'
             AND content_tsv @@ websearch_to_tsquery('english', $1)
           ORDER BY fts_score DESC
           LIMIT ${candidatePool}`,
          taskText, capabilityId,
        );
      } catch (err) {
        // tsvector column doesn't exist yet on this DB — skip the FTS branch.
        logger.warn({ err: (err as Error).message }, "[compose] FTS skipped — content_tsv missing on CapabilityKnowledgeArtifact");
      }
    }
    const ranked = fuseAndRerank(vectorRows, ftsRows, take, (r) => ({
      id: r.id, artifactType: r.artifactType, title: r.title, content: r.content,
      cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days),
      fts_score: Number((r as { fts_score?: number }).fts_score ?? 0),
    }));
    // M25.6 H3 — empty / all-weak result → fall back to "just give me the
    // most recent N rows". The flag on the returned objects lets the caller
    // tag the chunk so Run Insights can show "(recency fallback — no
    // semantic match)" instead of pretending the cosine score is real.
    if (EMPTY_FALLBACK_ENABLED && noMeaningfulHits(ranked)) {
      const recencyRows = await runtimeReader.capabilityKnowledgeArtifact.findMany({
        where: { capabilityId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: EMPTY_FALLBACK_TOPK,
        select: { id: true, artifactType: true, title: true, content: true, createdAt: true },
      });
      return recencyRows.map(r => ({
        id: r.id, artifactType: r.artifactType, title: r.title, content: r.content,
        cosineSimilarity: 0,
        ageDays: Math.max(0, (Date.now() - r.createdAt.getTime()) / 86_400_000),
        fts_score: 0,
        finalScore: 0,
        rrf_rank: null as number | null,
        fallbackKind: "recency_only" as const,
      }));
    }
    return ranked;
  },

  async semanticMemory(capabilityId: string, taskVec: string, take = DEFAULT_CONTEXT_BUDGET.memoryTopK, taskText?: string) {
    const candidatePool = 30;
    const mode = retrievalMode();
    type Row = {
      id: string; memoryType: string; title: string; content: string;
      cosine_similarity: number; age_days: number;
    };
    const vectorRows = mode === "fts" ? [] : await runtimeReader.$queryRawUnsafe<Row[]>(
      `SELECT id, "memoryType", title, content,
              1 - (embedding <=> $1::vector) AS cosine_similarity,
              EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days
       FROM "DistilledMemory"
       WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $2 AND status = 'ACTIVE' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT ${candidatePool}`,
      taskVec, capabilityId,
    );
    let ftsRows: Array<Row & { fts_score: number }> = [];
    if (mode !== "vector" && taskText && taskText.trim().length > 0) {
      try {
        ftsRows = await runtimeReader.$queryRawUnsafe<Array<Row & { fts_score: number }>>(
          `SELECT id, "memoryType", title, content,
                  0::float AS cosine_similarity,
                  EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days,
                  ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS fts_score
           FROM "DistilledMemory"
           WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $2 AND status = 'ACTIVE'
             AND content_tsv @@ websearch_to_tsquery('english', $1)
           ORDER BY fts_score DESC
           LIMIT ${candidatePool}`,
          taskText, capabilityId,
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "[compose] FTS skipped — content_tsv missing on DistilledMemory");
      }
    }
    const ranked = fuseAndRerank(vectorRows, ftsRows, take, (r) => ({
      id: r.id, memoryType: r.memoryType, title: r.title, content: r.content,
      cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days),
      fts_score: Number((r as { fts_score?: number }).fts_score ?? 0),
    }));
    // M25.6 H3 — see semanticKnowledge for rationale. Same shape as the
    // hybrid result so the caller stays uniform.
    if (EMPTY_FALLBACK_ENABLED && noMeaningfulHits(ranked)) {
      const recencyRows = await runtimeReader.distilledMemory.findMany({
        where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: EMPTY_FALLBACK_TOPK,
        select: { id: true, memoryType: true, title: true, content: true, createdAt: true },
      });
      return recencyRows.map(r => ({
        id: r.id, memoryType: r.memoryType, title: r.title, content: r.content,
        cosineSimilarity: 0,
        ageDays: Math.max(0, (Date.now() - r.createdAt.getTime()) / 86_400_000),
        fts_score: 0,
        finalScore: 0,
        rrf_rank: null as number | null,
        fallbackKind: "recency_only" as const,
      }));
    }
    return ranked;
  },

  async semanticSymbols(capabilityId: string, taskVec: string, take = DEFAULT_CONTEXT_BUDGET.codeTopK) {
    const candidatePool = 30;
    const finalTake = take;
    type Row = {
      symbol_id: string;
      symbolName: string | null; symbolType: string | null;
      filePath: string; startLine: number | null;
      summary: string | null; language: string | null;
      repoName: string;
      cosine_similarity: number; age_days: number;
    };
    // Joined query — embedding lives on CapabilityCodeEmbedding, scoping +
    // display fields live on CapabilityCodeSymbol + CapabilityRepository.
    const rows = await runtimeReader.$queryRawUnsafe<Row[]>(
      `SELECT s.id AS symbol_id,
              s."symbolName", s."symbolType", s."filePath", s."startLine",
              s.summary, s.language, r."repoName",
              1 - (e.embedding <=> $1::vector) AS cosine_similarity,
              EXTRACT(EPOCH FROM (now() - s."createdAt")) / 86400.0 AS age_days
       FROM "CapabilityCodeEmbedding" e
       JOIN "CapabilityCodeSymbol" s ON s.id = e."symbolId"
       JOIN "CapabilityRepository" r ON r.id = s."repositoryId"
       WHERE s."capabilityId" = $2 AND e.embedding IS NOT NULL
       ORDER BY e.embedding <=> $1::vector
       LIMIT ${candidatePool}`,
      taskVec, capabilityId,
    );
    return rerankByHybrid(
      rows.map(r => ({
        symbol_id: r.symbol_id,
        symbolName: r.symbolName,
        symbolType: r.symbolType,
        filePath: r.filePath,
        startLine: r.startLine,
        summary: r.summary,
        language: r.language,
        repoName: r.repoName,
        cosineSimilarity: Number(r.cosine_similarity),
        ageDays: Number(r.age_days),
        finalScore: 0,
      })),
      finalTake,
    );
  },

  // ── M25.5 — Context Compiler cache ──────────────────────────────────────
  //
  // The capsule cache is keyed by a stable hash of (capability, agent template,
  // normalized intent, content revision). The content revision is derived from
  // a single SQL roll-up (MAX(updatedAt) + COUNT across the three source
  // tables) so any artifact / memory write — including soft-deletes that bump
  // updatedAt — invalidates the capsule by making the key unreachable.
  //
  // The lookup returns the rendered layers + the typed chunks. Caller replays
  // those into the current assembly. We don't materialise the capsule's
  // compiledContent as a single paragraph in v0 — that's the M25.5.next LLM-
  // compile step. v0 saves the layers-and-chunks shape directly.

  async capabilityContentRevision(capabilityId: string): Promise<string> {
    type Row = {
      ka_max: string | null; ka_count: bigint | number | null;
      dm_max: string | null; dm_count: bigint | number | null;
    };
    const rows = await runtimeReader.$queryRawUnsafe<Row[]>(
      `SELECT
         (SELECT MAX("updatedAt") FROM "CapabilityKnowledgeArtifact"
            WHERE "capabilityId" = $1) AS ka_max,
         (SELECT COUNT(*) FROM "CapabilityKnowledgeArtifact"
            WHERE "capabilityId" = $1) AS ka_count,
         (SELECT MAX("updatedAt") FROM "DistilledMemory"
            WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $1) AS dm_max,
         (SELECT COUNT(*) FROM "DistilledMemory"
            WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $1) AS dm_count`,
      capabilityId,
    );
    const r = rows[0] ?? { ka_max: null, ka_count: 0, dm_max: null, dm_count: 0 };
    const parts = [
      r.ka_max ?? "-",   String(r.ka_count ?? 0),
      r.dm_max ?? "-",   String(r.dm_count ?? 0),
    ].join("|");
    // Hash client-side (avoids depending on Postgres' pgcrypto). 16 hex chars
    // is plenty for cache-key disambiguation.
    return sha256(parts).slice(0, 16);
  },

  async lookupCapsule(opts: {
    capabilityId:    string;
    agentTemplateId: string;
    intent:          string;
  }): Promise<{ id: string; layers: AssembledLayer[]; chunks: RetrievedChunk[]; mode: "RAW" | "LLM" } | null> {
    try {
      const contentRevision = await this.capabilityContentRevision(opts.capabilityId);
      const sig = taskSignature({
        capabilityId:    opts.capabilityId,
        agentTemplateId: opts.agentTemplateId,
        intent:          opts.intent,
        contentRevision,
      });
      const row = await prisma.capabilityCompiledContext.findUnique({
        where: { taskSignature: sig },
      });
      if (!row) return null;
      if (row.status !== "READY") return null;
      const mode = (row.compileMode === "LLM" ? "LLM" : "RAW") as "RAW" | "LLM";
      const chunks = (row.citations as unknown as RetrievedChunk[]) ?? [];

      let layers: AssembledLayer[] = [];
      if (mode === "LLM") {
        // M25.5.next — compiledContent is a single LLM-synthesised paragraph.
        // Replay as ONE RUNTIME_EVIDENCE layer at the same priority used by
        // raw retrieval. Tokens drop from ~Σ(chunk excerpts) to ~paragraph.
        const paragraph = row.compiledContent;
        layers = [{
          layerType:      "RUNTIME_EVIDENCE",
          priority:       PRIORITY.RUNTIME_EVIDENCE,
          inclusionReason: "capsule (LLM-compiled paragraph)",
          contentSnapshot: paragraph,
          layerHash:       sha256(paragraph),
        }];
      } else {
        // M25.5 v1 — compiledContent is JSON-stringified layer snapshots.
        try { layers = JSON.parse(row.compiledContent) as AssembledLayer[]; }
        catch { return null; }
      }
      return { id: row.id, layers, chunks, mode };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "[compose] lookupCapsule failed (continuing without cache)");
      return null;
    }
  },

  async storeCapsule(opts: {
    capabilityId:    string;
    agentTemplateId: string;
    intent:          string;
    layers:          AssembledLayer[];
    chunks:          RetrievedChunk[];
  }): Promise<void> {
    // M25.5 C3 — cap concurrent compiles per capability. Without this, an
    // invalidation that takes 20 task signatures cold + 50 concurrent
    // requesters would fire 50 parallel mcp-server compile calls. Bail
    // early instead — the cold path already served raw chunks to this
    // request, so we just skip the storeCapsule write.
    if (!tryAcquireCompileSlot(opts.capabilityId)) {
      logger.info({ capabilityId: opts.capabilityId },
        "[compose] storeCapsule skipped — compile-slot cap reached (C3)");
      return;
    }
    try {
      const contentRevision = await this.capabilityContentRevision(opts.capabilityId);
      const sig = taskSignature({
        capabilityId:    opts.capabilityId,
        agentTemplateId: opts.agentTemplateId,
        intent:          opts.intent,
        contentRevision,
      });

      // M25.5.next — when CAPSULE_COMPILE_MODE=LLM we attempt to compress the
      // chunks into one paragraph via mcp-server. Failure path silently falls
      // back to RAW mode so the cache is never empty.
      // M25.5 C5 — every LLM attempt is recorded in the failure-rate window;
      // a single 30s retry is scheduled per signature when the attempt fails
      // so transient errors self-heal without operator action.
      let mode: "RAW" | "LLM" = "RAW";
      let compiledContent = JSON.stringify(opts.layers);
      if (compileMode() === "LLM" && opts.chunks.length > 0) {
        const llm = await compileCapsuleViaLlm(opts.intent, opts.chunks);
        const success = Boolean(llm && llm.paragraph);
        recordCompileAttempt(success);
        if (success && llm) {
          mode = "LLM";
          compiledContent = llm.paragraph;
        } else {
          // Schedule a retry: re-attempt compile after RETRY_DELAY_MS and
          // upgrade the existing RAW row to LLM if it succeeds. The retry
          // bypasses C3's concurrency cap because there's exactly one
          // in-flight retry per signature (de-duplicated by pendingRetries).
          const captured = { intent: opts.intent, chunks: opts.chunks, signature: sig };
          scheduleCompileRetry(sig, async () => {
            const retry = await compileCapsuleViaLlm(captured.intent, captured.chunks);
            recordCompileAttempt(Boolean(retry?.paragraph));
            if (!retry?.paragraph) return;
            // The row was written below as RAW + status=READY. UPGRADE it
            // in place — taskSignature is unique so updateMany is safe.
            await prisma.capabilityCompiledContext.updateMany({
              where: { taskSignature: captured.signature },
              data: {
                compiledContent: retry.paragraph,
                compileMode: "LLM",
                estimatedTokens: estimateTokens(retry.paragraph),
              },
            }).catch((err: Error) => logger.warn({ err: err.message }, "[capsule] retry UPDATE failed"));
          });
        }
      }

      // M25.5 C9 — stamp TTL on every write so the GC sweeper has a
      // predicate to act on. capsuleExpiry() reads CAPSULE_TTL_DAYS.
      const expiresAt = capsuleExpiry();
      const estimatedTokens = estimateTokens(compiledContent);
      await prisma.capabilityCompiledContext.upsert({
        where: { taskSignature: sig },
        create: {
          capabilityId:    opts.capabilityId,
          agentTemplateId: opts.agentTemplateId,
          taskSignature:   sig,
          intent:          opts.intent.slice(0, 2000),
          compiledContent,
          compileMode:     mode,
          citations:       opts.chunks as never,
          estimatedTokens,
          status:          "READY",
          expiresAt,
        },
        update: {
          compiledContent,
          compileMode:   mode,
          citations:     opts.chunks as never,
          estimatedTokens,
          status:        "READY",
          intent:        opts.intent.slice(0, 2000),
          expiresAt,
        },
      });
    } finally {
      releaseCompileSlot(opts.capabilityId);
    }
  },
};

function humanLayer(layerType: string): string {
  return layerType.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}
