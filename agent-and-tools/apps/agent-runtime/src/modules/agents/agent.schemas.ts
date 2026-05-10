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
});
export type CreateAgentTemplateInput = z.infer<typeof createAgentTemplateSchema>;

export const listAgentTemplatesQuerySchema = z.object({
  roleType: agentRoleType.optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

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
