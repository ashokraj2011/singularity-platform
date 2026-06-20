/**
 * M40 — ImmutableContract service.
 *
 * Three concerns:
 *   1. mint() — assemble a bundle + hash + persist as ImmutableContract row
 *   2. get(id) — return the full bundle for replay
 *   3. listForAgent(agentTemplateId) — admin view of all contracts for an agent
 *
 * The mint() path fetches modelResolution from MCP's /llm/models endpoint.
 * Composer does not talk to the LLM gateway directly.
 */
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { assembleBundle } from "./bundler";
import { ValidationError } from "../../shared/errors";

const MCP_SERVER_URL     = (process.env.MCP_SERVER_URL ?? "http://mcp-server:7100").replace(/\/$/, "");
const MCP_BEARER_TOKEN   = process.env.MCP_BEARER_TOKEN ?? "";

export interface MintContractInput {
  agentTemplateId: string;
  agentTemplateVersion: number;
  capabilityId?: string;
  modelAlias?: string;
  capturedBy?: string;
  capturedFrom?: string;
  consumableId?: string;
}

type ModelCatalogResponse = {
  success?: boolean;
  data?: {
    defaultModelAlias?: string;
    default_model_alias?: string;
    models?: Array<{ id: string; provider: string; model: string; version?: string }>;
  };
  default_model_alias?: string;
  models?: Array<{ id: string; provider: string; model: string; version?: string }>;
};

export async function resolveModelAlias(alias: string | undefined): Promise<{
  alias: string | null;
  provider: string;
  model: string;
  version: string | null;
  resolvedAt: string;
}> {
  const resolvedAt = new Date().toISOString();
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (MCP_BEARER_TOKEN) headers.authorization = `Bearer ${MCP_BEARER_TOKEN}`;
    const res = await fetch(`${MCP_SERVER_URL}/llm/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn({ alias, status: res.status, body: text.slice(0, 200) },
        "[contracts] MCP model catalog failed; refusing unresolved contract model");
      throw new ValidationError(`Cannot mint ImmutableContract: model catalog lookup failed for alias "${alias ?? "<default>"}"`);
    }
    const json = await res.json() as ModelCatalogResponse;
    const defaultAlias = json.data?.defaultModelAlias ?? json.data?.default_model_alias ?? json.default_model_alias ?? null;
    const effectiveAlias = alias ?? defaultAlias;
    if (!effectiveAlias) {
      logger.warn({ alias }, "[contracts] model catalog has no default alias; refusing unresolved contract model");
      throw new ValidationError("Cannot mint ImmutableContract: no modelAlias supplied and model catalog has no default alias");
    }
    const models = json.data?.models ?? json.models ?? [];
    const row = models.find((model) => model.id === effectiveAlias);
    if (!row) {
      logger.warn({ alias: effectiveAlias }, "[contracts] model alias not found; refusing unresolved contract model");
      throw new ValidationError(`Cannot mint ImmutableContract: model alias "${effectiveAlias}" was not found in the model catalog`);
    }
    return {
      alias: effectiveAlias,
      provider: row.provider,
      model: row.model,
      version: row.version ?? null,
      resolvedAt,
    };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    logger.warn({ alias, err: (err as Error).message },
      "[contracts] MCP model catalog threw; refusing unresolved contract model");
    throw new ValidationError(`Cannot mint ImmutableContract: model catalog lookup failed for alias "${alias ?? "<default>"}"`);
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
