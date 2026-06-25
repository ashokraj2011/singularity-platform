import { MemoryPromotionStatus, Prisma } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import type { AuthUser } from "../../middleware/auth.middleware";
import { resolveMemoryReadScope, resolveCapabilityFilter } from "./memory.tenant-scope";

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

  async listExecution(
    filter?: { workflowExecutionId?: string; capabilityId?: string; promotionStatus?: MemoryPromotionStatus },
    user?: AuthUser,
  ) {
    // Tenant scoping: no-op for the default single-box deploy, forced capability
    // filter when this deployment is tenant-scoped (IAM_SERVICE_TOKEN_TENANT_IDS).
    // See memory.tenant-scope.ts — mirrors context-fabric's execute.py read scope.
    const scope = resolveMemoryReadScope(user);
    const allowedCapabilityIds = resolveCapabilityFilter(scope, filter?.capabilityId);
    const where: Prisma.WorkflowExecutionMemoryWhereInput = { ...(filter ?? {}) };
    if (allowedCapabilityIds) {
      where.capabilityId = allowedCapabilityIds.length === 1
        ? allowedCapabilityIds[0]
        : { in: allowedCapabilityIds };
    }
    return prisma.workflowExecutionMemory.findMany({
      where,
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

  async listDistilled(filter?: { scopeType?: string; scopeId?: string }, user?: AuthUser) {
    // Distilled memory is capability-scoped (scopeType="CAPABILITY", scopeId=capabilityId),
    // so the same tenant gate constrains scopeId to the caller's capabilities. Non-capability
    // scopes (if any) fall outside the allowed set and are hidden under strict isolation —
    // the safe choice given there is no tenant column to match them against.
    const scope = resolveMemoryReadScope(user);
    const allowedCapabilityIds = resolveCapabilityFilter(scope, filter?.scopeId);
    const where: Prisma.DistilledMemoryWhereInput = { ...(filter ?? {}) };
    if (allowedCapabilityIds) {
      where.scopeId = allowedCapabilityIds.length === 1
        ? allowedCapabilityIds[0]
        : { in: allowedCapabilityIds };
    }
    return prisma.distilledMemory.findMany({
      where, orderBy: { createdAt: "desc" }, take: 200,
    });
  },
};
