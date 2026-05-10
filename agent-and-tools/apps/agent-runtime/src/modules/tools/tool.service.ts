import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ConflictError, NotFoundError } from "../../shared/errors";

export const toolService = {
  async register(input: { name: string; namespace: string; description?: string; toolType?: string }) {
    try {
      return await prisma.toolDefinition.create({ data: { ...input, status: "ACTIVE" } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictError(`Tool ${input.namespace}.${input.name} already exists`);
      }
      throw err;
    }
  },

  async list(filter?: { namespace?: string; status?: string }) {
    return prisma.toolDefinition.findMany({
      where: filter ?? {},
      orderBy: { createdAt: "desc" },
      include: { contracts: { where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1 } },
    });
  },

  async get(id: string) {
    const tool = await prisma.toolDefinition.findUnique({
      where: { id },
      include: { contracts: { orderBy: { version: "desc" } } },
    });
    if (!tool) throw new NotFoundError("Tool not found");
    return tool;
  },

  async createContract(toolId: string, input: {
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    allowedUsage?: string;
    deniedUsage?: string;
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    requiresApproval: boolean;
    auditRequired: boolean;
    timeoutMs: number;
  }) {
    await this.get(toolId);
    const last = await prisma.toolContract.findFirst({ where: { toolId }, orderBy: { version: "desc" } });
    return prisma.toolContract.create({
      data: {
        toolId,
        inputSchema: input.inputSchema as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? null) as Prisma.InputJsonValue,
        allowedUsage: input.allowedUsage,
        deniedUsage: input.deniedUsage,
        riskLevel: input.riskLevel,
        requiresApproval: input.requiresApproval,
        auditRequired: input.auditRequired,
        timeoutMs: input.timeoutMs,
        version: (last?.version ?? 0) + 1,
        status: "ACTIVE",
      },
    });
  },

  async createPolicy(input: { name: string; description?: string; scopeType?: string; scopeId?: string }) {
    return prisma.toolPolicy.create({ data: { ...input, status: "ACTIVE" } });
  },

  async listPolicies() {
    return prisma.toolPolicy.findMany({ orderBy: { createdAt: "desc" }, include: { grants: true } });
  },

  async createGrant(input: {
    toolPolicyId: string; toolId: string;
    grantScopeType: "AGENT_TEMPLATE" | "AGENT_BINDING" | "CAPABILITY" | "ROLE" | "WORKFLOW_PHASE" | "TEAM" | "USER";
    grantScopeId: string;
    allowedActions?: string[]; deniedActions?: string[];
    environment?: string; workflowPhase?: string; requiresApprovalOverride?: boolean;
  }) {
    return prisma.toolGrant.create({
      data: {
        ...input,
        allowedActions: (input.allowedActions ?? []) as Prisma.InputJsonValue,
        deniedActions: (input.deniedActions ?? []) as Prisma.InputJsonValue,
        status: "ACTIVE",
      },
    });
  },

  async listGrants(filter?: { grantScopeType?: string; grantScopeId?: string }) {
    return prisma.toolGrant.findMany({
      where: filter ?? {},
      orderBy: { createdAt: "desc" },
      include: { tool: true, toolPolicy: true },
    });
  },
};
