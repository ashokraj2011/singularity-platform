import { z } from "zod";

export const riskLevel = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const grantScopeType = z.enum([
  "AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY", "ROLE", "WORKFLOW_PHASE", "TEAM", "USER",
]);

export const registerToolSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1),
  description: z.string().optional(),
  toolType: z.string().optional(),
});

export const createContractSchema = z.object({
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  allowedUsage: z.string().optional(),
  deniedUsage: z.string().optional(),
  riskLevel: riskLevel.default("LOW"),
  requiresApproval: z.boolean().default(false),
  auditRequired: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30000),
});

export const createPolicySchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  scopeType: z.string().optional(),
  scopeId: z.string().optional(),
});

export const grantSchema = z.object({
  toolPolicyId: z.string().uuid(),
  toolId: z.string().uuid(),
  grantScopeType,
  grantScopeId: z.string().min(1),
  allowedActions: z.array(z.string()).optional(),
  deniedActions: z.array(z.string()).optional(),
  environment: z.string().optional(),
  workflowPhase: z.string().optional(),
  requiresApprovalOverride: z.boolean().optional(),
});

export const validateCallSchema = z.object({
  agentExecutionId: z.string().uuid().optional(),
  agentTemplateId: z.string().uuid().optional(),
  agentBindingId: z.string().uuid().optional(),
  capabilityId: z.string().uuid().optional(),
  toolName: z.string().min(3),
  workflowPhase: z.string().optional(),
  environment: z.string().optional(),
  input: z.unknown(),
});
export type ValidateCallInput = z.infer<typeof validateCallSchema>;
