import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { NotFoundError } from "../../shared/errors";
import { sha256, estimateTokens } from "../../shared/hash";
import { render as renderMustache } from "../../shared/mustache";
import { toolServiceClient, DiscoveredTool } from "../../clients/tool-service.client";
import { contextFabricClient } from "../../clients/context-fabric.client";
import { ComposeInput, ArtifactInput } from "./compose.schemas";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "../../lib/embeddings";

// M15 — hybrid scoring helper. Cosine ∈ [-1, 1] → [0, 2] via (cos+1)/2 only
// when the caller asks; default keeps raw cosine because pgvector's `<=>`
// returns 1-cosine (a distance), not similarity. We compute similarity as
// `1 - distance` in the SQL query.
const RECENCY_BOOST_DAYS = Number(process.env.EMBEDDING_RECENCY_DAYS ?? 30);
const RECENCY_BOOST_MAX  = Number(process.env.EMBEDDING_RECENCY_BOOST ?? 0.2);

function recencyBoost(ageDays: number): number {
  if (ageDays >= RECENCY_BOOST_DAYS) return 0;
  if (ageDays <= 0) return RECENCY_BOOST_MAX;
  return ((RECENCY_BOOST_DAYS - ageDays) / RECENCY_BOOST_DAYS) * RECENCY_BOOST_MAX;
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

interface AssembledLayer {
  promptLayerId?: string;
  layerType: string;
  priority: number;
  inclusionReason: string;
  contentSnapshot: string;
  layerHash: string;
}

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

export const composeService = {
  /**
   * Full pipeline: assemble layered prompt → call context-fabric /chat/respond → return unified response.
   * If previewOnly is true, skip the LLM call and return the assembled package.
   */
  async composeAndRespond(input: ComposeInput) {
    const layers: AssembledLayer[] = [];
    const warnings: string[] = [];

    // Build the substitution context once.
    const ctx = await this.buildVarsContext(input);

    // 1. Agent template + base prompt profile
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");
    if (template.basePromptProfileId) {
      layers.push(...await this.loadProfileLayers(template.basePromptProfileId, "agent template base profile", ctx, warnings));
    }

    // 2. Binding overlay
    let binding: { id: string; promptProfileId: string | null; capabilityId: string | null } | null = null;
    if (input.agentBindingId) {
      binding = await prisma.agentCapabilityBinding.findUnique({
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
      const capability = await prisma.capability.findUnique({ where: { id: capabilityId } });
      if (capability) {
        const capContent = `Capability: ${capability.name}\nType: ${capability.capabilityType ?? "—"}\nCriticality: ${capability.criticality ?? "—"}\n${capability.description ?? ""}`;
        const r = renderMustache(capContent, ctx); warnings.push(...r.warnings);
        layers.push({ layerType: "CAPABILITY_CONTEXT", priority: PRIORITY.CAPABILITY_CONTEXT, inclusionReason: "capability scope provided", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });

        // M15 — embed the task once; reuse for all three retrieval queries.
        // Failure falls back to createdAt ordering so retrieval never blocks
        // composition.
        let taskVec: string | null = null;
        try {
          if (input.task && input.task.trim().length > 0) {
            const embedded = await getEmbeddingProvider().embed({ text: input.task.slice(0, 8_000) });
            assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
            taskVec = toVectorLiteral(embedded.vector);
          }
        } catch (err) {
          warnings.push(`embedding failed: ${(err as Error).message}`);
        }

        // ── Knowledge artifacts → RUNTIME_EVIDENCE ──────────────────────────
        const artifacts = taskVec
          ? await this.semanticKnowledge(capabilityId, taskVec)
          : (await prisma.capabilityKnowledgeArtifact.findMany({ where: { capabilityId, status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 10 }))
              .map(a => ({ ...a, cosineSimilarity: 0, ageDays: 0, finalScore: 0 }));
        for (const a of artifacts) {
          const c = `[${a.artifactType}] ${a.title}\n${a.content}`;
          const r2 = renderMustache(c, ctx); warnings.push(...r2.warnings);
          layers.push({
            layerType: "RUNTIME_EVIDENCE",
            priority: PRIORITY.RUNTIME_EVIDENCE,
            inclusionReason: taskVec
              ? `knowledge ${a.artifactType} (cos=${a.cosineSimilarity.toFixed(3)}, age=${a.ageDays.toFixed(1)}d)`
              : `knowledge artifact ${a.artifactType}`,
            contentSnapshot: r2.rendered,
            layerHash: sha256(r2.rendered),
          });
        }

        // ── Distilled memory → MEMORY_CONTEXT ──────────────────────────────
        const memory = taskVec
          ? await this.semanticMemory(capabilityId, taskVec)
          : (await prisma.distilledMemory.findMany({ where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 10 }))
              .map(m => ({ ...m, cosineSimilarity: 0, ageDays: 0, finalScore: 0 }));
        for (const m of memory) {
          const c = `[${m.memoryType}] ${m.title}\n${m.content}`;
          const r3 = renderMustache(c, ctx); warnings.push(...r3.warnings);
          layers.push({
            layerType: "MEMORY_CONTEXT",
            priority: PRIORITY.MEMORY_CONTEXT,
            inclusionReason: taskVec
              ? `distilled memory (cos=${m.cosineSimilarity.toFixed(3)}, age=${m.ageDays.toFixed(1)}d)`
              : "distilled memory match",
            contentSnapshot: r3.rendered,
            layerHash: sha256(r3.rendered),
          });
        }

        // ── Code symbols → CODE_CONTEXT ────────────────────────────────────
        const symbols = taskVec
          ? await this.semanticSymbols(capabilityId, taskVec)
          : (await prisma.capabilityCodeSymbol.findMany({
              where: { capabilityId }, orderBy: { createdAt: "desc" }, take: 8,
              include: { repository: true },
            })).map(s => ({
              symbol_id: s.id, symbolName: s.symbolName, symbolType: s.symbolType,
              filePath: s.filePath, startLine: s.startLine, summary: s.summary,
              language: s.language, repoName: s.repository?.repoName ?? "repo",
              cosineSimilarity: 0, ageDays: 0, finalScore: 0,
            }));
        for (const s of symbols) {
          const body = s.summary ?? `${s.symbolType ?? "symbol"} ${s.symbolName ?? ""}`;
          const c = `[${s.symbolType ?? "symbol"}] ${s.repoName}/${s.filePath}:${s.startLine ?? "?"}\n${body}`;
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
        }
      }
    }

    // 4. Workflow phase layers
    if (input.workflowContext.phaseId) {
      const phaseLayers = await prisma.promptLayer.findMany({ where: { scopeType: "WORKFLOW_PHASE", scopeId: input.workflowContext.phaseId, status: "ACTIVE" } });
      for (const l of phaseLayers) {
        const r = renderMustache(l.content, ctx); warnings.push(...r.warnings);
        layers.push({ promptLayerId: l.id, layerType: l.layerType, priority: PRIORITY.WORKFLOW_PHASE_BASE + l.priority, inclusionReason: `workflow phase ${input.workflowContext.phaseId}`, contentSnapshot: r.rendered, layerHash: l.contentHash ?? sha256(r.rendered) });
      }
    }

    // 5. Tool contracts — both DB-grant-driven and dynamic discovery
    const toolsLayer = await this.buildToolContractLayer(input, capabilityId, template.id);
    if (toolsLayer) {
      const r = renderMustache(toolsLayer, ctx); warnings.push(...r.warnings);
      layers.push({ layerType: "TOOL_CONTRACT", priority: PRIORITY.TOOL_CONTRACT, inclusionReason: "tool grants + dynamic discovery", contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }

    // 6. Artifact context (workgraph passes consumables)
    for (const art of input.artifacts) {
      const rendered = await this.renderArtifact(art);
      if (!rendered) continue;
      const r = renderMustache(rendered, ctx); warnings.push(...r.warnings);
      layers.push({ layerType: "ARTIFACT_CONTEXT", priority: PRIORITY.ARTIFACT_CONTEXT, inclusionReason: `artifact ${art.label} (${art.role})`, contentSnapshot: r.rendered, layerHash: sha256(r.rendered) });
    }

    // 7. Task context
    const taskRendered = renderMustache(input.task, ctx); warnings.push(...taskRendered.warnings);
    const taskContent = `# Current Task\n${taskRendered.rendered}`;
    layers.push({ layerType: "TASK_CONTEXT", priority: PRIORITY.TASK_CONTEXT, inclusionReason: "user task", contentSnapshot: taskContent, layerHash: sha256(taskContent) });

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
    const finalPrompt = layers.map(l => `# ${humanLayer(l.layerType)}\n${l.contentSnapshot}`).join("\n\n");
    const finalPromptHash = sha256(finalPrompt);

    // 10. Persist PromptAssembly
    const assembly = await prisma.promptAssembly.create({
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
        estimatedInputTokens: estimateTokens(finalPrompt),
        layers: {
          create: layers.map(l => ({
            promptLayerId: l.promptLayerId ?? null,
            layerType: l.layerType, layerHash: l.layerHash, priority: l.priority,
            included: true, inclusionReason: l.inclusionReason, contentSnapshot: l.contentSnapshot,
          })),
        },
      },
    });

    const layersUsed = layers.map(l => ({ layerType: l.layerType, priority: l.priority, layerHash: l.layerHash, inclusionReason: l.inclusionReason }));
    const dedupedWarnings = Array.from(new Set(warnings));

    if (input.previewOnly) {
      return {
        promptAssemblyId: assembly.id,
        promptHash: finalPromptHash,
        estimatedInputTokens: assembly.estimatedInputTokens,
        layersUsed,
        warnings: dedupedWarnings,
        assembled: {
          systemPrompt: finalPrompt,
          message: taskRendered.rendered,
        },
      };
    }

    // 11. Call context-fabric /chat/respond
    const sessionId = `wf:${input.workflowContext.instanceId}:${input.workflowContext.nodeId}`;
    const cfResp = await contextFabricClient.chatRespond({
      session_id: sessionId,
      agent_id: input.agentTemplateId,
      message: taskRendered.rendered,
      provider: input.modelOverrides.provider,
      model: input.modelOverrides.model,
      temperature: input.modelOverrides.temperature,
      max_output_tokens: input.modelOverrides.maxOutputTokens,
      system_prompt: finalPrompt,
      context_policy: input.contextPolicy.optimizationMode || input.contextPolicy.maxContextTokens || input.contextPolicy.compareWithRaw !== undefined ? {
        optimization_mode: input.contextPolicy.optimizationMode,
        max_context_tokens: input.contextPolicy.maxContextTokens,
        compare_with_raw: input.contextPolicy.compareWithRaw,
      } : undefined,
      metadata: {
        promptAssemblyId: assembly.id,
        workflowInstanceId: input.workflowContext.instanceId,
        nodeId: input.workflowContext.nodeId,
        phaseId: input.workflowContext.phaseId,
        capabilityId,
      },
    });

    logger.info({ promptAssemblyId: assembly.id, modelCallId: cfResp.model_call_id, tokensSaved: cfResp.optimization.tokens_saved }, "compose-and-respond complete");

    return {
      promptAssemblyId: assembly.id,
      promptHash: finalPromptHash,
      estimatedInputTokens: assembly.estimatedInputTokens,
      layersUsed,
      warnings: dedupedWarnings,
      modelCallId: cfResp.model_call_id,
      contextPackageId: cfResp.context_package_id,
      response: cfResp.response,
      optimization: cfResp.optimization,
      modelUsage: cfResp.model_usage,
    };
  },

  async buildVarsContext(input: ComposeInput): Promise<Record<string, unknown>> {
    // Load capability metadata for {{capability.metadata.*}}
    let capabilityMeta: Record<string, unknown> = {};
    const capabilityId = input.capabilityId;
    if (capabilityId) {
      const cap = await prisma.capability.findUnique({ where: { id: capabilityId } });
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
          layerType: l.promptLayer.layerType,
          priority: l.priority,
          inclusionReason: reason,
          contentSnapshot: r.rendered,
          layerHash: sha256(r.rendered),
        };
      });
  },

  async buildToolContractLayer(input: ComposeInput, capabilityId: string | null, agentTemplateId: string): Promise<string | null> {
    // Static grants (existing model)
    const scopeFilters: Array<{ grantScopeType: string; grantScopeId: string }> = [
      { grantScopeType: "AGENT_TEMPLATE", grantScopeId: agentTemplateId },
    ];
    if (input.agentBindingId) scopeFilters.push({ grantScopeType: "AGENT_BINDING", grantScopeId: input.agentBindingId });
    if (capabilityId) scopeFilters.push({ grantScopeType: "CAPABILITY", grantScopeId: capabilityId });

    const grants = await prisma.toolGrant.findMany({
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
        json_schema: { input: c?.inputSchema ?? {}, output: c?.outputSchema ?? {} },
        risk_level: c?.riskLevel ?? "LOW",
        requires_approval: c?.requiresApproval ?? false,
      }));
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
          json_schema: { input: t.input_schema, output: {} },
          risk_level: t.risk_level,
          requires_approval: false,
        }));
      }
    }

    if (blocks.length === 0) return null;
    return `Available tools:\n\n${blocks.join("\n\n")}`;
  },

  renderToolBlock(t: {
    tool_name: string;
    natural_language: string;
    json_schema: { input: unknown; output: unknown };
    risk_level: string;
    requires_approval: boolean;
  }): string {
    return `## Tool: ${t.tool_name}
Description: ${t.natural_language}
Risk: ${t.risk_level}${t.requires_approval ? " (requires approval)" : ""}
JSON Schema:
\`\`\`json
${JSON.stringify(t.json_schema, null, 2)}
\`\`\``;
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

  async semanticKnowledge(capabilityId: string, taskVec: string) {
    const candidatePool = 30;
    const finalTake = 10;
    type Row = {
      id: string; artifactType: string; title: string; content: string;
      cosine_similarity: number; age_days: number;
    };
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id, "artifactType", title, content,
              1 - (embedding <=> $1::vector) AS cosine_similarity,
              EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days
       FROM "CapabilityKnowledgeArtifact"
       WHERE "capabilityId" = $2 AND status = 'ACTIVE' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT ${candidatePool}`,
      taskVec, capabilityId,
    );
    return rerankByHybrid(
      rows.map(r => ({
        id: r.id, artifactType: r.artifactType, title: r.title, content: r.content,
        cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days), finalScore: 0,
      })),
      finalTake,
    );
  },

  async semanticMemory(capabilityId: string, taskVec: string) {
    const candidatePool = 30;
    const finalTake = 10;
    type Row = {
      id: string; memoryType: string; title: string; content: string;
      cosine_similarity: number; age_days: number;
    };
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id, "memoryType", title, content,
              1 - (embedding <=> $1::vector) AS cosine_similarity,
              EXTRACT(EPOCH FROM (now() - "createdAt")) / 86400.0 AS age_days
       FROM "DistilledMemory"
       WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $2 AND status = 'ACTIVE' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT ${candidatePool}`,
      taskVec, capabilityId,
    );
    return rerankByHybrid(
      rows.map(r => ({
        id: r.id, memoryType: r.memoryType, title: r.title, content: r.content,
        cosineSimilarity: Number(r.cosine_similarity), ageDays: Number(r.age_days), finalScore: 0,
      })),
      finalTake,
    );
  },

  async semanticSymbols(capabilityId: string, taskVec: string) {
    const candidatePool = 30;
    const finalTake = 8;
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
    const rows = await prisma.$queryRawUnsafe<Row[]>(
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
        symbol_id:        r.symbol_id,
        symbolName:       r.symbolName,
        symbolType:       r.symbolType,
        filePath:         r.filePath,
        startLine:        r.startLine,
        summary:          r.summary,
        language:         r.language,
        repoName:         r.repoName,
        cosineSimilarity: Number(r.cosine_similarity),
        ageDays:          Number(r.age_days),
        finalScore:       0,
      })),
      finalTake,
    );
  },
};

function humanLayer(layerType: string): string {
  return layerType.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}
