import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { CreateAgentTemplateInput } from "./agent.schemas";

export const agentService = {
  async createTemplate(input: CreateAgentTemplateInput, userId?: string) {
    return prisma.agentTemplate.create({
      data: { ...input, createdBy: userId, status: "DRAFT" },
    });
  },

  async listTemplates(filter: { roleType?: string; status?: string; page: number; limit: number }) {
    const where: Record<string, unknown> = {};
    if (filter.roleType) where.roleType = filter.roleType;
    if (filter.status) where.status = filter.status;
    const [items, total] = await Promise.all([
      prisma.agentTemplate.findMany({
        where, skip: (filter.page - 1) * filter.limit, take: filter.limit,
        orderBy: { createdAt: "desc" },
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
