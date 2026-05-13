import { z } from "zod";

export const promptScopeType = z.enum([
  "PLATFORM", "TENANT", "BUSINESS_UNIT", "CAPABILITY",
  "AGENT_TEMPLATE", "AGENT_BINDING", "WORKFLOW", "WORKFLOW_PHASE", "EXECUTION",
]);

export const promptLayerType = z.enum([
  "PLATFORM_CONSTITUTION", "TENANT_CONTEXT", "BUSINESS_UNIT_CONTEXT", "AGENT_ROLE",
  "SKILL_CONTRACT", "TOOL_CONTRACT", "CAPABILITY_CONTEXT", "REPOSITORY_CONTEXT",
  "WORKFLOW_CONTEXT", "PHASE_CONTEXT", "TASK_CONTEXT", "RUNTIME_EVIDENCE",
  "MEMORY_CONTEXT", "CODE_CONTEXT",
  "OUTPUT_CONTRACT", "APPROVAL_POLICY", "DATA_ACCESS_POLICY",
]);

export const createProfileSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  ownerScopeType: promptScopeType.optional(),
  ownerScopeId: z.string().optional(),
});

export const createLayerSchema = z.object({
  name: z.string().min(2),
  layerType: promptLayerType,
  scopeType: promptScopeType,
  scopeId: z.string().optional(),
  content: z.string().min(1),
  priority: z.number().int().default(100),
  isRequired: z.boolean().default(false),
});

export const updateLayerSchema = z.object({
  name: z.string().min(2).optional(),
  layerType: promptLayerType.optional(),
  scopeType: promptScopeType.optional(),
  scopeId: z.string().optional().nullable(),
  content: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  isRequired: z.boolean().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one editable field is required.",
});

export const attachLayerSchema = z.object({
  promptLayerId: z.string().uuid(),
  priority: z.number().int().default(100),
  isEnabled: z.boolean().default(true),
});

export const assembleSchema = z.object({
  agentTemplateId: z.string().uuid(),
  agentBindingId: z.string().uuid().optional(),
  capabilityId: z.string().uuid().optional(),
  workflowExecutionId: z.string().optional(),
  workflowPhase: z.string().optional(),
  task: z.string().min(1),
  modelProvider: z.string().optional(),
  modelName: z.string().optional(),
});
export type AssembleInput = z.infer<typeof assembleSchema>;
