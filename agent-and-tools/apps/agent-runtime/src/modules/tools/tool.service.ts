import { EntityStatus, Prisma, ToolGrantScopeType } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";
import type { AuthUser } from "../../middleware/auth.middleware";
import { requirePlatformAdmin } from "../../lib/authz/platform-admin";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors";
import { assertCapabilityNotArchived } from "../capabilities/capability-lifecycle";

type ToolDbClient = typeof prisma | Prisma.TransactionClient;

type StatusRow = { status: string };
type TemplateGrantScopeRow = { status: string; capabilityId: string | null };
type BindingGrantScopeRow = { status: string; capabilityId: string; agentTemplateId: string };
const LIFECYCLE_SCOPED_TOOL_POLICY_TYPES = new Set<string>(["AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY"]);

function normalizedToolPolicyScopeType(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

async function assertActiveToolForWrite(client: ToolDbClient, toolId: string, action: string): Promise<void> {
  const rows = await client.$queryRaw<StatusRow[]>(Prisma.sql`
    SELECT status
    FROM "ToolDefinition"
    WHERE id = ${toolId}
    FOR UPDATE
  `);
  const tool = rows[0];
  if (!tool) throw new NotFoundError("Tool not found");
  if (tool.status !== "ACTIVE") throw new ConflictError(`Tool is ${tool.status} and cannot ${action}.`);
}

async function assertActiveToolPolicyForGrant(client: ToolDbClient, toolPolicyId: string): Promise<void> {
  const rows = await client.$queryRaw<StatusRow[]>(Prisma.sql`
    SELECT status
    FROM "ToolPolicy"
    WHERE id = ${toolPolicyId}
    FOR UPDATE
  `);
  const policy = rows[0];
  if (!policy) throw new NotFoundError("Tool policy not found");
  if (policy.status !== "ACTIVE") throw new ConflictError(`Tool policy is ${policy.status} and cannot receive grants.`);
}

async function assertActiveCapabilityForGrant(client: ToolDbClient, capabilityId: string, action: string): Promise<void> {
  const rows = await client.$queryRaw<StatusRow[]>(Prisma.sql`
    SELECT status
    FROM "Capability"
    WHERE id = ${capabilityId}
    FOR UPDATE
  `);
  const capability = rows[0];
  if (!capability) throw new NotFoundError("Capability not found");
  assertCapabilityNotArchived(capability, `Cannot ${action} for an archived capability.`);
  if (capability.status !== "ACTIVE") throw new ConflictError(`Capability is ${capability.status} and cannot receive active grants.`);
}

async function assertGrantScopeWritable(
  client: ToolDbClient,
  input: { grantScopeType: ToolGrantScopeType | string; grantScopeId: string },
): Promise<void> {
  switch (input.grantScopeType) {
    case "CAPABILITY":
      await assertActiveCapabilityForGrant(client, input.grantScopeId, "create a tool grant");
      return;
    case "AGENT_TEMPLATE": {
      const rows = await client.$queryRaw<TemplateGrantScopeRow[]>(Prisma.sql`
        SELECT status, "capabilityId" AS "capabilityId"
        FROM "AgentTemplate"
        WHERE id = ${input.grantScopeId}
        FOR UPDATE
      `);
      const template = rows[0];
      if (!template) throw new NotFoundError("Agent template not found");
      if (template.status === "ARCHIVED") throw new ForbiddenError("Cannot create a tool grant for an archived agent template.");
      if (template.capabilityId) {
        await assertActiveCapabilityForGrant(client, template.capabilityId, "create a template-scoped tool grant");
      }
      return;
    }
    case "AGENT_BINDING": {
      const rows = await client.$queryRaw<BindingGrantScopeRow[]>(Prisma.sql`
        SELECT status, "capabilityId" AS "capabilityId", "agentTemplateId" AS "agentTemplateId"
        FROM "AgentCapabilityBinding"
        WHERE id = ${input.grantScopeId}
        FOR UPDATE
      `);
      const binding = rows[0];
      if (!binding) throw new NotFoundError("Agent capability binding not found");
      if (binding.status !== "ACTIVE") {
        throw new ConflictError(`Agent capability binding is ${binding.status} and cannot receive grants.`);
      }
      await assertActiveCapabilityForGrant(client, binding.capabilityId, "create a binding-scoped tool grant");
      return;
    }
    default:
      return;
  }
}

async function lockToolContractVersionSequence(client: ToolDbClient, toolId: string): Promise<void> {
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`tool-contract:${toolId}`}))`;
}

export const toolService = {
  async register(input: { name: string; namespace: string; description?: string; toolType?: string }, actor?: AuthUser) {
    requirePlatformAdmin(actor, "Registering a tool");
    try {
      return await prisma.toolDefinition.create({ data: { ...input, status: "ACTIVE" } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictError(`Tool ${input.namespace}.${input.name} already exists`);
      }
      throw err;
    }
  },

  async list(filter?: { namespace?: string; status?: EntityStatus }) {
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
  }, actor?: AuthUser) {
    requirePlatformAdmin(actor, "Creating a tool contract");
    return prisma.$transaction(async (tx) => {
      await assertActiveToolForWrite(tx, toolId, "receive contracts");
      await lockToolContractVersionSequence(tx, toolId);
      const last = await tx.toolContract.findFirst({ where: { toolId }, orderBy: { version: "desc" } });
      return tx.toolContract.create({
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
    });
  },

  async createPolicy(input: { name: string; description?: string; scopeType?: string; scopeId?: string }, actor?: AuthUser) {
    requirePlatformAdmin(actor, "Creating a tool policy");
    const scopeType = normalizedToolPolicyScopeType(input.scopeType);
    return prisma.$transaction(async (tx) => {
      if (scopeType && LIFECYCLE_SCOPED_TOOL_POLICY_TYPES.has(scopeType)) {
        if (!input.scopeId) throw new ConflictError("Scoped tool policy requires a scopeId.");
        await assertGrantScopeWritable(tx, { grantScopeType: scopeType, grantScopeId: input.scopeId });
      }
      return tx.toolPolicy.create({
        data: {
          ...input,
          scopeType: scopeType ?? input.scopeType,
          status: "ACTIVE",
        },
      });
    });
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
  }, actor?: AuthUser) {
    requirePlatformAdmin(actor, "Creating a tool grant");
    return prisma.$transaction(async (tx) => {
      await assertActiveToolForWrite(tx, input.toolId, "receive grants");
      await assertActiveToolPolicyForGrant(tx, input.toolPolicyId);
      await assertGrantScopeWritable(tx, input);
      return tx.toolGrant.create({
        data: {
          ...input,
          allowedActions: (input.allowedActions ?? []) as Prisma.InputJsonValue,
          deniedActions: (input.deniedActions ?? []) as Prisma.InputJsonValue,
          status: "ACTIVE",
        },
      });
    });
  },

  async listGrants(filter?: { grantScopeType?: ToolGrantScopeType; grantScopeId?: string }) {
    return prisma.toolGrant.findMany({
      where: filter ?? {},
      orderBy: { createdAt: "desc" },
      include: { tool: true, toolPolicy: true },
    });
  },
};
