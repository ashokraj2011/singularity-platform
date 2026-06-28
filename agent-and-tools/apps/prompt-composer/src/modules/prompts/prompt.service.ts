import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import type { AuthUser } from "../../middleware/auth.middleware";
import {
  assertCanManageScope,
  assertCanViewScope,
  layerScopeWhere,
  profileScopeWhere,
} from "./prompt-authz";

export const promptService = {
  async createProfile(
    input: { name: string; description?: string; ownerScopeType?: string; ownerScopeId?: string },
    actor?: AuthUser,
  ) {
    assertCanManageScope(actor, input.ownerScopeType ?? null, input.ownerScopeId ?? null, "prompt profiles");
    return prisma.promptProfile.create({
      data: { ...input, ownerScopeType: input.ownerScopeType as never, status: "DRAFT" },
    });
  },

  async listProfiles(actor?: AuthUser) {
    return prisma.promptProfile.findMany({
      where: profileScopeWhere(actor),
      orderBy: { createdAt: "desc" },
      include: { layers: { include: { promptLayer: true } } },
    });
  },

  async getProfile(id: string, actor?: AuthUser) {
    const profile = await prisma.promptProfile.findUnique({
      where: { id },
      include: { layers: { include: { promptLayer: true }, orderBy: { priority: "asc" } } },
    });
    if (!profile) throw new NotFoundError("Prompt profile not found");
    assertCanViewScope(actor, profile.ownerScopeType, profile.ownerScopeId, "Prompt profile not found");
    return profile;
  },

  async createLayer(
    input: {
      name: string; layerType: string; scopeType: string; scopeId?: string;
      content: string; priority: number; isRequired: boolean;
    },
    actor?: AuthUser,
  ) {
    assertCanManageScope(actor, input.scopeType, input.scopeId ?? null, "prompt layers");
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

  async updateLayer(
    id: string,
    input: {
      name?: string; layerType?: string; scopeType?: string; scopeId?: string | null;
      content?: string; priority?: number; isRequired?: boolean; status?: string;
    },
    actor?: AuthUser,
  ) {
    const existing = await prisma.promptLayer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Prompt layer not found");
    // Must be able to manage the layer in its CURRENT scope...
    assertCanManageScope(actor, existing.scopeType, existing.scopeId, "prompt layers");
    // ...and, if this update re-scopes it, in the TARGET scope too — so a layer
    // can't be reassigned into (or out of) a capability you don't own.
    const nextScopeType = input.scopeType ?? existing.scopeType;
    const nextScopeId = input.scopeId === undefined ? existing.scopeId : input.scopeId || null;
    if (nextScopeType !== existing.scopeType || nextScopeId !== existing.scopeId) {
      assertCanManageScope(actor, nextScopeType, nextScopeId, "prompt layers");
    }

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

  async listLayers(filter?: { scopeType?: string; layerType?: string }, actor?: AuthUser) {
    const where: Record<string, unknown> = { ...layerScopeWhere(actor) };
    if (filter?.scopeType) where.scopeType = filter.scopeType;
    if (filter?.layerType) where.layerType = filter.layerType;
    return prisma.promptLayer.findMany({ where, orderBy: { createdAt: "desc" } });
  },

  async attachLayer(profileId: string, layerId: string, priority: number, isEnabled: boolean, actor?: AuthUser) {
    const profile = await this.getProfile(profileId, actor); // throws NotFound if not viewable
    // Attaching changes the profile's composition → require manage on the profile.
    assertCanManageScope(actor, profile.ownerScopeType, profile.ownerScopeId, "prompt profile layers");
    const layer = await prisma.promptLayer.findUnique({ where: { id: layerId } });
    if (!layer) throw new NotFoundError("Prompt layer not found");
    // Referencing a layer needs only view rights (you may compose a global
    // layer into your capability's profile), not manage rights on the layer.
    assertCanViewScope(actor, layer.scopeType, layer.scopeId, "Prompt layer not found");
    return prisma.promptProfileLayer.upsert({
      where: { promptProfileId_promptLayerId: { promptProfileId: profileId, promptLayerId: layerId } },
      create: { promptProfileId: profileId, promptLayerId: layerId, priority, isEnabled },
      update: { priority, isEnabled },
    });
  },
};
