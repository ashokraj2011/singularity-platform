import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";

export const capabilityService = {
  async create(input: {
    name: string; parentCapabilityId?: string; capabilityType?: string;
    businessUnitId?: string; ownerTeamId?: string; criticality?: string; description?: string;
  }) {
    return prisma.capability.create({ data: { ...input, status: "ACTIVE" } });
  },

  async list() {
    return prisma.capability.findMany({
      orderBy: { createdAt: "desc" },
      include: { children: true, repositories: true },
    });
  },

  async get(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        children: true,
        parent: true,
        repositories: true,
        knowledgeArtifacts: { orderBy: { createdAt: "desc" } },
        bindings: { include: { agentTemplate: true } },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");
    return cap;
  },

  async attachRepository(capabilityId: string, input: {
    repoName: string; repoUrl: string; defaultBranch: string; repositoryType: string;
  }) {
    await this.get(capabilityId);
    return prisma.capabilityRepository.create({
      data: { ...input, capabilityId, status: "ACTIVE" },
    });
  },

  async bindAgent(capabilityId: string, input: {
    agentTemplateId: string; bindingName: string;
    roleInCapability?: string; promptProfileId?: string;
    toolPolicyId?: string; memoryScopePolicyId?: string;
  }, userId?: string) {
    await this.get(capabilityId);
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");
    return prisma.agentCapabilityBinding.create({
      data: { ...input, capabilityId, createdBy: userId, status: "ACTIVE" },
    });
  },

  async listBindings(capabilityId: string) {
    return prisma.agentCapabilityBinding.findMany({
      where: { capabilityId },
      include: { agentTemplate: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async addKnowledge(capabilityId: string, input: {
    artifactType: string; title: string; content: string;
    sourceType?: string; sourceRef?: string; confidence?: number;
  }) {
    await this.get(capabilityId);
    return prisma.capabilityKnowledgeArtifact.create({
      data: {
        capabilityId,
        artifactType: input.artifactType,
        title: input.title,
        content: input.content,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        confidence: input.confidence,
        contentHash: sha256(input.content),
        status: "ACTIVE",
      },
    });
  },

  async listKnowledge(capabilityId: string) {
    return prisma.capabilityKnowledgeArtifact.findMany({
      where: { capabilityId },
      orderBy: { createdAt: "desc" },
    });
  },
};
