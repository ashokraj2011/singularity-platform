import Ajv from "ajv";
import addFormats from "ajv-formats";
import { prisma } from "../../config/prisma";
import { ValidateCallInput } from "./tool.schemas";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export interface ValidateResult {
  allowed: boolean;
  requiresApproval: boolean;
  riskLevel: string;
  reason: string;
}

type GrantScopeFilter = { grantScopeType: "AGENT_TEMPLATE" | "AGENT_BINDING" | "CAPABILITY"; grantScopeId: string };

export const toolValidationService = {
  async validate(input: ValidateCallInput): Promise<ValidateResult> {
    // 1. Resolve tool by namespace.name
    const dot = input.toolName.indexOf(".");
    if (dot < 0) return deny("Tool name must be 'namespace.name'", "LOW");
    const namespace = input.toolName.slice(0, dot);
    const name = input.toolName.slice(dot + 1);

    const tool = await prisma.toolDefinition.findFirst({
      where: { namespace, name, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
    if (!tool) return deny(`Tool ${input.toolName} not found or inactive`, "LOW");

    // 2. Latest active contract
    const contract = await prisma.toolContract.findFirst({
      where: { toolId: tool.id, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
    if (!contract) return deny(`No active contract for ${input.toolName}`, "LOW");

    // 3. Validate input schema
    const validateFn = ajv.compile(contract.inputSchema as object);
    if (!validateFn(input.input)) {
      return deny(`Input failed schema: ${ajv.errorsText(validateFn.errors)}`, contract.riskLevel);
    }

    // 4. Resolve and validate the live grant scopes before consulting grants.
    // A stale grant row must not authorize calls through an archived capability
    // or inactive template/binding.
    const scopeResolution = await resolveRuntimeGrantScopes(input);
    if (!scopeResolution.allowed) return deny(scopeResolution.reason, contract.riskLevel);

    const grants = await prisma.toolGrant.findMany({
      where: { toolId: tool.id, status: "ACTIVE", OR: scopeResolution.filters as never },
    });

    // 5. Filter by workflow phase + environment (null on grant means "any")
    const applicable = grants.filter(g =>
      (!g.workflowPhase || g.workflowPhase === input.workflowPhase) &&
      (!g.environment || g.environment === input.environment)
    );

    if (applicable.length === 0) {
      return deny(`Tool ${input.toolName} is not granted for this scope/phase/environment`, contract.riskLevel);
    }

    // 6. Approval: contract default OR any applicable grant override
    const overrides = applicable.map(g => g.requiresApprovalOverride).filter(v => v !== null && v !== undefined);
    const requiresApproval = overrides.length > 0 ? overrides.some(Boolean) : contract.requiresApproval;

    return {
      allowed: true,
      requiresApproval,
      riskLevel: contract.riskLevel,
      reason: `Tool granted via ${applicable[0].grantScopeType}=${applicable[0].grantScopeId}`,
    };
  },
};

function deny(reason: string, risk: string): ValidateResult {
  return { allowed: false, requiresApproval: false, riskLevel: risk, reason };
}

async function resolveRuntimeGrantScopes(input: ValidateCallInput): Promise<
  { allowed: true; filters: GrantScopeFilter[] } | { allowed: false; reason: string }
> {
  const filters: GrantScopeFilter[] = [];

  if (input.agentTemplateId) {
    const template = await prisma.agentTemplate.findUnique({
      where: { id: input.agentTemplateId },
      select: { id: true, status: true, capabilityId: true },
    });
    if (!template) return { allowed: false, reason: "Agent template scope not found" };
    if (template.status !== "ACTIVE") {
      return { allowed: false, reason: `Agent template scope is ${template.status} and cannot authorize tool calls` };
    }
    if (input.capabilityId && template.capabilityId && template.capabilityId !== input.capabilityId) {
      return { allowed: false, reason: "Agent template scope belongs to another capability" };
    }
    if (template.capabilityId) {
      const activeCapability = await capabilityIsActive(template.capabilityId);
      if (!activeCapability.active) return { allowed: false, reason: activeCapability.reason };
    }
    filters.push({ grantScopeType: "AGENT_TEMPLATE", grantScopeId: input.agentTemplateId });
  }

  if (input.agentBindingId) {
    const binding = await prisma.agentCapabilityBinding.findUnique({
      where: { id: input.agentBindingId },
      select: { id: true, status: true, capabilityId: true, agentTemplateId: true },
    });
    if (!binding) return { allowed: false, reason: "Agent binding scope not found" };
    if (binding.status !== "ACTIVE") {
      return { allowed: false, reason: `Agent binding scope is ${binding.status} and cannot authorize tool calls` };
    }
    if (input.agentTemplateId && binding.agentTemplateId !== input.agentTemplateId) {
      return { allowed: false, reason: "Agent binding scope belongs to another template" };
    }
    if (input.capabilityId && binding.capabilityId !== input.capabilityId) {
      return { allowed: false, reason: "Agent binding scope belongs to another capability" };
    }
    const activeCapability = await capabilityIsActive(binding.capabilityId);
    if (!activeCapability.active) return { allowed: false, reason: activeCapability.reason };
    filters.push({ grantScopeType: "AGENT_BINDING", grantScopeId: input.agentBindingId });
  }

  if (input.capabilityId) {
    const activeCapability = await capabilityIsActive(input.capabilityId);
    if (!activeCapability.active) return { allowed: false, reason: activeCapability.reason };
    filters.push({ grantScopeType: "CAPABILITY", grantScopeId: input.capabilityId });
  }

  if (filters.length === 0) {
    return { allowed: false, reason: "No agent / binding / capability scope provided to resolve grants" };
  }
  return { allowed: true, filters };
}

async function capabilityIsActive(capabilityId: string): Promise<{ active: true } | { active: false; reason: string }> {
  const capability = await prisma.capability.findUnique({
    where: { id: capabilityId },
    select: { status: true },
  });
  if (!capability) return { active: false, reason: "Capability scope not found" };
  if (capability.status !== "ACTIVE") {
    return { active: false, reason: `Capability scope is ${capability.status} and cannot authorize tool calls` };
  }
  return { active: true };
}
