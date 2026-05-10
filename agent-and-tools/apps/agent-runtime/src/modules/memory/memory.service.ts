import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";

export const memoryService = {
  async storeExecution(input: {
    workflowExecutionId: string; capabilityId?: string; agentBindingId?: string;
    memoryType: string; title?: string; content: string;
    evidenceRefs?: string[]; confidence?: number;
  }) {
    return prisma.workflowExecutionMemory.create({
      data: {
        ...input,
        evidenceRefs: (input.evidenceRefs ?? []) as Prisma.InputJsonValue,
        promotionStatus: "NOT_REVIEWED",
      },
    });
  },

  async listExecution(filter?: { workflowExecutionId?: string; capabilityId?: string; promotionStatus?: string }) {
    return prisma.workflowExecutionMemory.findMany({
      where: filter ?? {},
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  },

  async review(id: string, decision: "APPROVED" | "REJECTED" | "CANDIDATE") {
    const mem = await prisma.workflowExecutionMemory.findUnique({ where: { id } });
    if (!mem) throw new NotFoundError("Execution memory not found");
    return prisma.workflowExecutionMemory.update({
      where: { id }, data: { promotionStatus: decision },
    });
  },

  async promote(input: {
    sourceMemoryIds: string[]; scopeType: string; scopeId: string;
    memoryType: string; title: string; content: string;
    approvedBy?: string; confidence?: number;
  }) {
    const distilled = await prisma.distilledMemory.create({
      data: {
        scopeType: input.scopeType, scopeId: input.scopeId,
        memoryType: input.memoryType, title: input.title, content: input.content,
        sourceExecutionIds: input.sourceMemoryIds as Prisma.InputJsonValue,
        approvedBy: input.approvedBy,
        confidence: input.confidence,
        version: 1, status: "ACTIVE",
      },
    });

    // Mark sources as PROMOTED
    await prisma.workflowExecutionMemory.updateMany({
      where: { id: { in: input.sourceMemoryIds } },
      data: { promotionStatus: "PROMOTED" },
    });

    return distilled;
  },

  async listDistilled(filter?: { scopeType?: string; scopeId?: string }) {
    return prisma.distilledMemory.findMany({
      where: filter ?? {}, orderBy: { createdAt: "desc" }, take: 200,
    });
  },
};
