/**
 * @deprecated M29 gate — DO NOT EXTEND.
 *
 * Prompt-profile / prompt-layer CRUD was ported to prompt-composer in M2.
 * agent-runtime's HTTP routes for /api/v1/prompts/* are NOT mounted in
 * app.ts and have not been since the M2 cutover. This file remains only
 * because executions/execution.service.ts still imports promptAssemblyService
 * — once that import is removed (M29 deprecation), this entire directory
 * can be deleted and the prompt-composer DB split (Decision 2) becomes safe.
 *
 * Until then: every model accessed here (PromptProfile, PromptLayer,
 * PromptProfileLayer) must remain mirrored in agent-runtime's Prisma schema
 * so prompt-composer's `prisma db push` doesn't drop them. The
 * schema-drift-guard CI job enforces this.
 *
 * If you need new prompt-profile or prompt-layer functionality, add it to
 * prompt-composer (apps/prompt-composer/src/modules/prompts/) instead.
 */
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";

export const promptService = {
  async createProfile(input: { name: string; description?: string; ownerScopeType?: string; ownerScopeId?: string }) {
    return prisma.promptProfile.create({
      data: { ...input, ownerScopeType: input.ownerScopeType as never, status: "DRAFT" },
    });
  },

  async listProfiles() {
    return prisma.promptProfile.findMany({
      orderBy: { createdAt: "desc" },
      include: { layers: { include: { promptLayer: true } } },
    });
  },

  async getProfile(id: string) {
    const profile = await prisma.promptProfile.findUnique({
      where: { id },
      include: { layers: { include: { promptLayer: true }, orderBy: { priority: "asc" } } },
    });
    if (!profile) throw new NotFoundError("Prompt profile not found");
    return profile;
  },

  async createLayer(input: {
    name: string; layerType: string; scopeType: string; scopeId?: string;
    content: string; priority: number; isRequired: boolean;
  }) {
    const contentHash = sha256(input.content);
    return prisma.promptLayer.create({
      data: {
        ...input,
        layerType: input.layerType as never,
        scopeType: input.scopeType as never,
        contentHash,
        status: "ACTIVE",
      },
    });
  },

  async listLayers(filter?: { scopeType?: string; layerType?: string }) {
    const where: Record<string, unknown> = {};
    if (filter?.scopeType) where.scopeType = filter.scopeType;
    if (filter?.layerType) where.layerType = filter.layerType;
    return prisma.promptLayer.findMany({ where, orderBy: { createdAt: "desc" } });
  },

  async attachLayer(profileId: string, layerId: string, priority: number, isEnabled: boolean) {
    await this.getProfile(profileId);
    const layer = await prisma.promptLayer.findUnique({ where: { id: layerId } });
    if (!layer) throw new NotFoundError("Prompt layer not found");
    return prisma.promptProfileLayer.upsert({
      where: { promptProfileId_promptLayerId: { promptProfileId: profileId, promptLayerId: layerId } },
      create: { promptProfileId: profileId, promptLayerId: layerId, priority, isEnabled },
      update: { priority, isEnabled },
    });
  },
};
