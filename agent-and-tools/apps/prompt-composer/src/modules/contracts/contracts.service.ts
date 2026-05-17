/**
 * M40 — ImmutableContract service.
 *
 * Three concerns:
 *   1. mint() — assemble a bundle + hash + persist as ImmutableContract row
 *   2. get(id) — return the full bundle for replay
 *   3. listForAgent(agentTemplateId) — admin view of all contracts for an agent
 *
 * The mint() path fetches modelResolution from llm-gateway's
 * GET /v1/models/resolve endpoint (M40 adds this) — composer doesn't know
 * how to bind an alias to a concrete (provider, model, version).
 */
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { assembleBundle } from "./bundler";

const LLM_GATEWAY_URL    = (process.env.LLM_GATEWAY_URL ?? "http://llm-gateway:8001").replace(/\/$/, "");
const LLM_GATEWAY_BEARER = process.env.LLM_GATEWAY_BEARER ?? "";

export interface MintContractInput {
  agentTemplateId: string;
  agentTemplateVersion: number;
  capabilityId?: string;
  modelAlias?: string;
  capturedBy?: string;
  capturedFrom?: string;
  consumableId?: string;
}

async function resolveModelAlias(alias: string | undefined): Promise<{
  alias: string | null;
  provider: string;
  model: string;
  version: string | null;
  resolvedAt: string;
}> {
  const resolvedAt = new Date().toISOString();
  if (!alias) {
    return { alias: null, provider: "unresolved", model: "unresolved", version: null, resolvedAt };
  }
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${LLM_GATEWAY_BEARER}`;
    const res = await fetch(`${LLM_GATEWAY_URL}/v1/models/resolve?alias=${encodeURIComponent(alias)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn({ alias, status: res.status, body: text.slice(0, 200) },
        "[contracts] llm-gateway model-resolve failed; bundle uses placeholder");
      return { alias, provider: "unresolved", model: alias, version: null, resolvedAt };
    }
    const json = await res.json() as { provider: string; model: string; version?: string };
    return {
      alias,
      provider: json.provider,
      model: json.model,
      version: json.version ?? null,
      resolvedAt,
    };
  } catch (err) {
    logger.warn({ alias, err: (err as Error).message },
      "[contracts] llm-gateway model-resolve threw; bundle uses placeholder");
    return { alias, provider: "unresolved", model: alias, version: null, resolvedAt };
  }
}

export const contractsService = {
  async mint(input: MintContractInput): Promise<{ id: string; bundleHash: string }> {
    const modelResolution = await resolveModelAlias(input.modelAlias);
    const bundle = await assembleBundle({
      agentTemplateId: input.agentTemplateId,
      capabilityId: input.capabilityId,
      modelResolution,
    });

    // Idempotent: if this exact bundleHash already exists, return its id.
    // Different mint calls with the same agent/version + no changes upstream
    // produce identical hashes — return the existing contract row.
    const existing = await prisma.immutableContract.findUnique({
      where: { bundleHash: bundle.bundleHash },
      select: { id: true, bundleHash: true },
    });
    if (existing) {
      return { id: existing.id, bundleHash: existing.bundleHash };
    }

    const row = await prisma.immutableContract.create({
      data: {
        bundleHash: bundle.bundleHash,
        agentTemplateId: input.agentTemplateId,
        agentTemplateVersion: input.agentTemplateVersion,
        capabilityId: input.capabilityId ?? null,
        promptProfileVersions: bundle.promptProfileVersions as never,
        promptLayerVersions: bundle.promptLayerVersions as never,
        systemPromptVersions: bundle.systemPromptVersions as never,
        stageBindingVersions: bundle.stageBindingVersions as never,
        toolPins: bundle.toolPins as never,
        modelResolution: bundle.modelResolution as never,
        capturedBy: input.capturedBy ?? null,
        capturedFrom: input.capturedFrom ?? null,
        consumableId: input.consumableId ?? null,
      },
    });
    logger.info(
      { id: row.id, bundleHash: bundle.bundleHash, agentTemplateId: input.agentTemplateId, version: input.agentTemplateVersion },
      "[contracts] minted new ImmutableContract",
    );
    return { id: row.id, bundleHash: bundle.bundleHash };
  },

  async get(id: string) {
    return prisma.immutableContract.findUnique({ where: { id } });
  },

  async getByHash(bundleHash: string) {
    return prisma.immutableContract.findUnique({ where: { bundleHash } });
  },

  async listForAgent(agentTemplateId: string) {
    return prisma.immutableContract.findMany({
      where: { agentTemplateId },
      orderBy: { capturedAt: "desc" },
      take: 50,
      select: {
        id: true, bundleHash: true, agentTemplateVersion: true,
        capturedAt: true, capturedBy: true, capturedFrom: true, consumableId: true,
      },
    });
  },
};
