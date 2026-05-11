import { prisma } from "../../config/prisma";
import { ForbiddenError, NotFoundError } from "../../shared/errors";
import {
  CreateAgentTemplateInput, DeriveAgentTemplateInput, UpdateAgentTemplateInput,
} from "./agent.schemas";

export const agentService = {
  async createTemplate(input: CreateAgentTemplateInput, userId?: string) {
    return prisma.agentTemplate.create({
      data: { ...input, createdBy: userId, status: "DRAFT" },
    });
  },

  async listTemplates(filter: {
    roleType?: string; status?: string;
    scope?: "common" | "capability" | "all";
    capabilityId?: string;
    page: number; limit: number;
  }) {
    const where: Record<string, unknown> = {};
    if (filter.roleType) where.roleType = filter.roleType;
    if (filter.status) where.status = filter.status;
    // M23 — scope filter for Agent Studio.
    //   common     ⟹ capabilityId IS NULL
    //   capability ⟹ capabilityId = <given>
    //   all (or omitted with capabilityId set) ⟹ common ∪ capabilityId rows
    if (filter.scope === "common") {
      where.capabilityId = null;
    } else if (filter.scope === "capability" && filter.capabilityId) {
      where.capabilityId = filter.capabilityId;
    } else if (filter.capabilityId) {
      where.OR = [{ capabilityId: null }, { capabilityId: filter.capabilityId }];
    }
    const [items, total] = await Promise.all([
      prisma.agentTemplate.findMany({
        where, skip: (filter.page - 1) * filter.limit, take: filter.limit,
        orderBy: [{ capabilityId: "asc" }, { createdAt: "desc" }],
        include: { skills: { include: { skill: true } } },
      }),
      prisma.agentTemplate.count({ where }),
    ]);
    return { items, total, page: filter.page, limit: filter.limit };
  },

  async getTemplate(id: string) {
    const template = await prisma.agentTemplate.findUnique({
      where: { id },
      include: { skills: { include: { skill: true } } },
    });
    if (!template) throw new NotFoundError("Agent template not found");
    return template;
  },

  // M23 — derive a capability-scoped child template. Carries the base
  // template's prompt profile + role + tool policy by default; caller can
  // override `name`, `description`, and `basePromptProfileId`.
  async deriveTemplate(baseId: string, input: DeriveAgentTemplateInput, userId?: string) {
    const base = await prisma.agentTemplate.findUnique({ where: { id: baseId } });
    if (!base) throw new NotFoundError("Base agent template not found");
    const derived = await prisma.agentTemplate.create({
      data: {
        name: input.name ?? `${base.name} (${input.capabilityId.slice(0, 8)})`,
        description: input.description ?? base.description ?? undefined,
        roleType: base.roleType,
        basePromptProfileId: input.basePromptProfileId ?? base.basePromptProfileId ?? undefined,
        defaultToolPolicyId: base.defaultToolPolicyId ?? undefined,
        capabilityId: input.capabilityId,
        baseTemplateId: base.id,
        // Derived templates are editable by capability owners — no lock.
        lockedReason: null,
        status: "DRAFT",
        createdBy: userId,
      },
      include: { skills: { include: { skill: true } } },
    });
    return derived;
  },

  // M23 — patch a template. Common (locked) templates reject patches unless
  // the caller is platform-admin.
  async updateTemplate(id: string, patch: UpdateAgentTemplateInput, isPlatformAdmin: boolean) {
    const existing = await prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Agent template not found");
    if (existing.lockedReason && !isPlatformAdmin) {
      throw new ForbiddenError(`Template is locked: ${existing.lockedReason}`);
    }
    return prisma.agentTemplate.update({
      where: { id },
      data: patch,
      include: { skills: { include: { skill: true } } },
    });
  },

  async createSkill(input: { name: string; skillType: string; description?: string; promptLayerId?: string }) {
    return prisma.agentSkill.create({ data: { ...input, status: "ACTIVE" } });
  },

  async listSkills() {
    return prisma.agentSkill.findMany({ orderBy: { createdAt: "desc" } });
  },

  async attachSkill(agentTemplateId: string, skillId: string, isDefault: boolean) {
    await this.getTemplate(agentTemplateId);
    const skill = await prisma.agentSkill.findUnique({ where: { id: skillId } });
    if (!skill) throw new NotFoundError("Skill not found");
    return prisma.agentTemplateSkill.upsert({
      where: { agentTemplateId_skillId: { agentTemplateId, skillId } },
      create: { agentTemplateId, skillId, isDefault },
      update: { isDefault },
    });
  },
};
