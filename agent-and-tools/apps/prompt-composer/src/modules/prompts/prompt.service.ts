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

  async updateLayer(id: string, input: {
    name?: string; layerType?: string; scopeType?: string; scopeId?: string | null;
    content?: string; priority?: number; isRequired?: boolean; status?: string;
  }) {
    const existing = await prisma.promptLayer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Prompt layer not found");

    const contentChanged = input.content !== undefined && input.content !== existing.content;
    return prisma.promptLayer.update({
      where: { id },
      data: {
        name: input.name,
        layerType: input.layerType as never,
        scopeType: input.scopeType as never,
        scopeId: input.scopeId === undefined ? undefined : input.scopeId || null,
        content: input.content,
        priority: input.priority,
        isRequired: input.isRequired,
        status: input.status as never,
        contentHash: contentChanged ? sha256(input.content as string) : undefined,
        version: contentChanged ? { increment: 1 } : undefined,
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
