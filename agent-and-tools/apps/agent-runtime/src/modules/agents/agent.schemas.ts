import { z } from "zod";

export const agentRoleType = z.enum([
  "ARCHITECT", "DEVELOPER", "QA", "GOVERNANCE",
  "BUSINESS_ANALYST", "PRODUCT_OWNER", "DEVOPS", "SECURITY",
]);

export const createAgentTemplateSchema = z.object({
  name: z.string().min(2).max(200),
  roleType: agentRoleType,
  description: z.string().optional(),
  instructions: z.string().max(20_000).optional(),
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
  instructions: z.string().max(20_000).optional(),
  basePromptProfileId: z.string().uuid().optional(),
  defaultToolPolicyId: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]).optional(),
  changeSummary: z.string().max(500).optional(),
});
export type UpdateAgentTemplateInput = z.infer<typeof updateAgentTemplateSchema>;

export const restoreAgentTemplateVersionSchema = z.object({
  changeSummary: z.string().max(500).optional(),
});
export type RestoreAgentTemplateVersionInput = z.infer<typeof restoreAgentTemplateVersionSchema>;

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

export const capabilityPermissionSchema = z.enum(["read", "invoke", "configure", "edit"]);
export const skillSourceTypeSchema = z.enum(["local", "provider_manifest", "url_document", "uploaded_document"]);

export const profileSkillBindingSchema = z.object({
  sourceType: skillSourceTypeSchema,
  skillId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  skillType: z.string().min(2).max(80).optional(),
  promptLayerId: z.string().uuid().optional(),
  sourceRef: z.string().max(1000).optional(),
  providerManifestUrl: z.string().url().optional(),
  url: z.string().url().optional(),
  fileName: z.string().max(500).optional(),
  permissions: z.array(capabilityPermissionSchema).optional(),
  readOnly: z.boolean().optional(),
  providerLocked: z.boolean().optional(),
  isDefault: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const createAgentProfileSchema = z.object({
  capabilityId: z.string().uuid(),
  name: z.string().min(2).max(200),
  roleType: agentRoleType,
  description: z.string().max(1000).optional(),
  instructions: z.string().max(20_000).optional(),
  basePromptProfileId: z.string().uuid().optional(),
  defaultToolPolicyId: z.string().uuid().optional(),
  skillBindings: z.array(profileSkillBindingSchema).max(30).default([]),
});
export type CreateAgentProfileInput = z.infer<typeof createAgentProfileSchema>;

export const previewSkillSourceSchema = z.object({
  sourceType: skillSourceTypeSchema,
  sourceRef: z.string().max(1000).optional(),
  providerManifestUrl: z.string().url().optional(),
  url: z.string().url().optional(),
  fileName: z.string().max(500).optional(),
  name: z.string().max(200).optional(),
});
export type PreviewSkillSourceInput = z.infer<typeof previewSkillSourceSchema>;
