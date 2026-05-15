import { z } from "zod";
import { agentRoleType } from "../agents/agent.schemas";

export const createCapabilitySchema = z.object({
  name: z.string().min(2),
  appId: z.string().max(120).optional(),
  parentCapabilityId: z.string().uuid().optional(),
  capabilityType: z.string().optional(),
  businessUnitId: z.string().optional(),
  ownerTeamId: z.string().optional(),
  criticality: z.string().optional(),
  description: z.string().optional(),
});

export const updateCapabilitySchema = z.object({
  name: z.string().min(2).optional(),
  appId: z.string().max(120).nullable().optional(),
  parentCapabilityId: z.string().uuid().nullable().optional(),
  capabilityType: z.string().nullable().optional(),
  businessUnitId: z.string().nullable().optional(),
  ownerTeamId: z.string().nullable().optional(),
  criticality: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
}).refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  "At least one capability field is required.",
);

const localFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(500_000),
});

export const attachRepositorySchema = z.object({
  repoName: z.string().min(1),
  repoUrl: z.string().url(),
  defaultBranch: z.string().default("main"),
  repositoryType: z.string().default("GITHUB"),
});

export const bootstrapCapabilitySchema = createCapabilitySchema.extend({
  targetWorkflowPattern: z.string().max(80).optional(),
  agentPreset: z.enum(["minimal", "engineering_core", "governed_delivery"]).default("governed_delivery"),
  includeAgentKeys: z.array(z.string().min(1).max(80)).max(20).optional(),
  excludeAgentKeys: z.array(z.string().min(1).max(80)).max(20).optional(),
  repositories: z.array(attachRepositorySchema.partial({ repoName: true }).extend({
    repoUrl: z.string().url(),
  })).max(5).default([]),
  documentLinks: z.array(z.object({
    url: z.string().url(),
    artifactType: z.string().min(2).max(50).default("DOC"),
    title: z.string().max(200).optional(),
    pollIntervalSec: z.number().int().min(60).max(86400).nullable().optional(),
  })).max(20).default([]),
  localFiles: z.array(localFileSchema).max(500).default([]),
});

export const reviewBootstrapSchema = z.object({
  approveGroupKeys: z.array(z.string().min(1)).default([]),
  rejectGroupKeys: z.array(z.string().min(1)).default([]),
  activateAgentTemplateIds: z.array(z.string().uuid()).default([]),
});

export const syncCapabilitySchema = z.object({
  repositoryIds: z.array(z.string().uuid()).optional(),
  knowledgeSourceIds: z.array(z.string().uuid()).optional(),
  localFiles: z.array(localFileSchema).max(2000).optional(),
});

export const learningWorkerRunSchema = z.object({
  approveGroupKeys: z.array(z.string().min(1)).default([]),
  rejectGroupKeys: z.array(z.string().min(1)).default([]),
  activateAgentTemplateIds: z.array(z.string().uuid()).default([]),
  syncApprovedSources: z.boolean().default(true),
  reembed: z.boolean().default(true),
  reembedKinds: z.array(z.enum(["knowledge", "memory", "code"])).default(["knowledge", "memory", "code"]),
  dryRun: z.boolean().default(false),
});

export const bindAgentSchema = z.object({
  agentTemplateId: z.string().uuid(),
  bindingName: z.string().min(2),
  roleInCapability: agentRoleType.optional(),
  promptProfileId: z.string().uuid().optional(),
  toolPolicyId: z.string().uuid().optional(),
  memoryScopePolicyId: z.string().uuid().optional(),
});

export const knowledgeArtifactSchema = z.object({
  artifactType: z.string().min(2),
  title: z.string().min(2),
  content: z.string().min(1),
  sourceType: z.string().optional(),
  sourceRef: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

// M14 — code-symbol extraction. Caller sends a flat list of files; the
// regex-based extractor walks them server-side and persists symbols +
// embeddings. Path is relative to the repo root the user picked client-side.
export const extractSymbolsSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1)
    .max(2000),
});

// M17 — polling configuration patches.
export const updateRepoPollSchema = z.object({
  pollIntervalSec: z.number().int().min(60).max(86400).nullable().optional(),
  defaultBranch:   z.string().min(1).max(100).optional(),
});

export const knowledgeSourceSchema = z.object({
  url:             z.string().url(),
  artifactType:    z.string().min(2).max(50).default("DOC"),
  title:           z.string().max(200).optional(),
  pollIntervalSec: z.number().int().min(60).max(86400).nullable().optional(),
});

export const updateKnowledgeSourceSchema = knowledgeSourceSchema.partial();
