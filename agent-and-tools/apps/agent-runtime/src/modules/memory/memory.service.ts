import { MemoryPromotionStatus, Prisma } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors";
import type { AuthUser } from "../../middleware/auth.middleware";
import { resolveMemoryReadScope, resolveCapabilityFilter } from "./memory.tenant-scope";
import { assertCapabilityNotArchived } from "../capabilities/capability-lifecycle";

type MemoryDbClient = typeof prisma | Prisma.TransactionClient;

type MemoryBindingRow = {
  id: string;
  bindingName: string;
  status: string;
  capabilityId: string;
};

type ExecutionMemoryScopeRow = {
  id: string;
  capabilityId: string | null;
  agentBindingId: string | null;
};

async function assertMemoryCapabilityWritable(
  client: MemoryDbClient,
  capabilityId: string,
  archivedMessage: string,
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT status
    FROM "Capability"
    WHERE id = ${capabilityId}
    FOR UPDATE
  `);
  const capability = rows[0];
  if (!capability) throw new NotFoundError("Capability not found");
  assertCapabilityNotArchived(capability, archivedMessage);
}

async function lockMemoryBinding(
  client: MemoryDbClient,
  agentBindingId: string,
): Promise<MemoryBindingRow | null> {
  const rows = await client.$queryRaw<MemoryBindingRow[]>(Prisma.sql`
    SELECT id, "bindingName" AS "bindingName", status, "capabilityId" AS "capabilityId"
    FROM "AgentCapabilityBinding"
    WHERE id = ${agentBindingId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockExecutionMemory(
  client: MemoryDbClient,
  memoryId: string,
): Promise<ExecutionMemoryScopeRow | null> {
  const rows = await client.$queryRaw<ExecutionMemoryScopeRow[]>(Prisma.sql`
    SELECT id, "capabilityId" AS "capabilityId", "agentBindingId" AS "agentBindingId"
    FROM "WorkflowExecutionMemory"
    WHERE id = ${memoryId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

export const memoryService = {
  async storeExecution(input: {
    workflowExecutionId: string; capabilityId?: string; agentBindingId?: string;
    memoryType: string; title?: string; content: string;
    evidenceRefs?: string[]; confidence?: number;
  }) {
    return prisma.$transaction(async (tx) => {
      const capabilityId = await validateExecutionMemoryScope(tx, input.capabilityId, input.agentBindingId);
      return tx.workflowExecutionMemory.create({
        data: {
          ...input,
          capabilityId,
          evidenceRefs: (input.evidenceRefs ?? []) as Prisma.InputJsonValue,
          promotionStatus: "NOT_REVIEWED",
        },
      });
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
    return prisma.$transaction(async (tx) => {
      const mem = await lockExecutionMemory(tx, id);
      if (!mem) throw new NotFoundError("Execution memory not found");
      const capabilityId = await resolveWritableExecutionMemoryCapability(
        tx,
        mem,
        "Cannot review execution memory for an archived capability.",
      );
      return tx.workflowExecutionMemory.update({
        where: { id: mem.id },
        data: {
          promotionStatus: decision,
          ...(capabilityId && !mem.capabilityId ? { capabilityId } : {}),
        },
      });
    });
  },

  async promote(input: {
    sourceMemoryIds: string[]; scopeType: string; scopeId: string;
    memoryType: string; title: string; content: string;
    approvedBy?: string; confidence?: number;
  }) {
    const scopeType = input.scopeType.trim().toUpperCase();
    return prisma.$transaction(async (tx) => {
      await validateDistilledMemoryPromotionScope(tx, { ...input, scopeType });
      const distilled = await tx.distilledMemory.create({
        data: {
          scopeType, scopeId: input.scopeId,
          memoryType: input.memoryType, title: input.title, content: input.content,
          sourceExecutionIds: input.sourceMemoryIds as Prisma.InputJsonValue,
          approvedBy: input.approvedBy,
          confidence: input.confidence,
          version: 1, status: "ACTIVE",
        },
      });

      // Mark sources as PROMOTED
      await tx.workflowExecutionMemory.updateMany({
        where: { id: { in: input.sourceMemoryIds } },
        data: { promotionStatus: "PROMOTED" },
      });

      return distilled;
    });
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

async function validateExecutionMemoryScope(
  client: MemoryDbClient,
  capabilityId?: string,
  agentBindingId?: string,
): Promise<string | undefined> {
  let resolvedCapabilityId = capabilityId;
  if (agentBindingId) {
    const binding = await lockMemoryBinding(client, agentBindingId);
    if (!binding) throw new NotFoundError("Agent capability binding not found");
    if (binding.status !== "ACTIVE") {
      throw new ConflictError(`Agent capability binding "${binding.bindingName}" is ${binding.status} and cannot receive execution memory.`);
    }
    if (capabilityId && binding.capabilityId !== capabilityId) {
      throw new ForbiddenError("Execution memory binding belongs to another capability.");
    }
    resolvedCapabilityId = binding.capabilityId;
  }

  if (resolvedCapabilityId) {
    await assertMemoryCapabilityWritable(client, resolvedCapabilityId, "Cannot store execution memory for an archived capability.");
  }
  return resolvedCapabilityId;
}

async function validateDistilledMemoryPromotionScope(
  client: MemoryDbClient,
  input: {
    sourceMemoryIds: string[];
    scopeType: string;
    scopeId: string;
  },
) {
  if (input.scopeType !== "CAPABILITY") return;
  await assertMemoryCapabilityWritable(client, input.scopeId, "Cannot promote distilled memory for an archived capability.");

  const sourceMemoryIds = Array.from(new Set(input.sourceMemoryIds));
  const sources = await client.$queryRaw<ExecutionMemoryScopeRow[]>(Prisma.sql`
    SELECT id, "capabilityId" AS "capabilityId", "agentBindingId" AS "agentBindingId"
    FROM "WorkflowExecutionMemory"
    WHERE id IN (${Prisma.join(sourceMemoryIds)})
    FOR UPDATE
  `);
  if (sources.length !== new Set(input.sourceMemoryIds).size) {
    throw new NotFoundError("One or more source execution memories were not found");
  }
  const crossScope = sources.find(source => source.capabilityId && source.capabilityId !== input.scopeId);
  if (crossScope) {
    throw new ForbiddenError("Cannot promote execution memory from another capability.");
  }

  const bindingIds = Array.from(new Set(sources.map(source => source.agentBindingId).filter((id): id is string => Boolean(id))));
  if (bindingIds.length === 0) return;
  const bindings = await client.$queryRaw<Array<{ id: string; status: string; capabilityId: string }>>(Prisma.sql`
    SELECT id, status, "capabilityId" AS "capabilityId"
    FROM "AgentCapabilityBinding"
    WHERE id IN (${Prisma.join(bindingIds)})
    FOR UPDATE
  `);
  const bindingsById = new Map(bindings.map(binding => [binding.id, binding]));
  for (const bindingId of bindingIds) {
    const binding = bindingsById.get(bindingId);
    if (!binding) throw new NotFoundError("Agent capability binding not found");
    if (binding.status !== "ACTIVE") throw new ConflictError("Cannot promote memory from an inactive agent capability binding.");
    if (binding.capabilityId !== input.scopeId) throw new ForbiddenError("Cannot promote execution memory from another capability binding.");
  }
}

async function resolveWritableExecutionMemoryCapability(
  client: MemoryDbClient,
  memory: ExecutionMemoryScopeRow,
  archivedMessage: string,
): Promise<string | undefined> {
  let capabilityId = memory.capabilityId ?? undefined;
  if (!capabilityId && memory.agentBindingId) {
    const binding = await lockMemoryBinding(client, memory.agentBindingId);
    if (!binding) throw new NotFoundError("Agent capability binding not found");
    if (binding.status !== "ACTIVE") throw new ConflictError("Cannot mutate memory from an inactive agent capability binding.");
    capabilityId = binding.capabilityId;
  }
  if (capabilityId) {
    await assertMemoryCapabilityWritable(client, capabilityId, archivedMessage);
  }
  return capabilityId;
}
