import { z } from "zod";

export const agentRoleType = z.enum([
  "ARCHITECT", "DEVELOPER", "QA", "GOVERNANCE",
  "BUSINESS_ANALYST", "PRODUCT_OWNER", "DEVOPS", "SECURITY",
]);

export const createAgentTemplateSchema = z.object({
  name: z.string().min(2).max(200),
  roleType: agentRoleType,
  description: z.string().optional(),
  basePromptProfileId: z.string().uuid().optional(),
  defaultToolPolicyId: z.string().uuid().optional(),
  // M23 — capability-scoped templates (created from scratch, no derivation)
  capabilityId: z.string().uuid().optional(),
});
export type CreateAgentTemplateInput = z.infer<typeof createAgentTemplateSchema>;

export const listAgentTemplatesQuerySchema = z.object({
  roleType: agentRoleType.optional(),
  status: z.string().optional(),
  // M23 — scope filter for Agent Studio
  scope: z.enum(["common", "capability", "all"]).optional(),
  capabilityId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// M23 — derive a capability-scoped child from a common (or other) template
export const deriveAgentTemplateSchema = z.object({
  capabilityId: z.string().uuid(),
  name: z.string().min(2).max(200).optional(),
  description: z.string().optional(),
  basePromptProfileId: z.string().uuid().optional(),
});
export type DeriveAgentTemplateInput = z.infer<typeof deriveAgentTemplateSchema>;

// M23 — patch a capability-derived template; common templates reject any patch
export const updateAgentTemplateSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().optional(),
  basePromptProfileId: z.string().uuid().optional(),
  defaultToolPolicyId: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]).optional(),
});
export type UpdateAgentTemplateInput = z.infer<typeof updateAgentTemplateSchema>;

export const createSkillSchema = z.object({
  name: z.string().min(2),
  skillType: z.string().min(2),
  description: z.string().optional(),
  promptLayerId: z.string().uuid().optional(),
});

export const attachSkillSchema = z.object({
  skillId: z.string().uuid(),
  isDefault: z.boolean().default(true),
});
