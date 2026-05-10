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

    // 4. Resolve grants. A call is allowed if AT LEAST ONE applicable grant exists.
    const orFilters: Array<Record<string, string>> = [];
    if (input.agentTemplateId) orFilters.push({ grantScopeType: "AGENT_TEMPLATE", grantScopeId: input.agentTemplateId });
    if (input.agentBindingId) orFilters.push({ grantScopeType: "AGENT_BINDING", grantScopeId: input.agentBindingId });
    if (input.capabilityId) orFilters.push({ grantScopeType: "CAPABILITY", grantScopeId: input.capabilityId });

    if (orFilters.length === 0) {
      return deny("No agent / binding / capability scope provided to resolve grants", contract.riskLevel);
    }

    const grants = await prisma.toolGrant.findMany({
      where: { toolId: tool.id, status: "ACTIVE", OR: orFilters as never },
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
