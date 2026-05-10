import { z } from "zod";

export const createCapabilitySchema = z.object({
  name: z.string().min(2),
  parentCapabilityId: z.string().uuid().optional(),
  capabilityType: z.string().optional(),
  businessUnitId: z.string().optional(),
  ownerTeamId: z.string().optional(),
  criticality: z.string().optional(),
  description: z.string().optional(),
});

export const attachRepositorySchema = z.object({
  repoName: z.string().min(1),
  repoUrl: z.string().url(),
  defaultBranch: z.string().default("main"),
  repositoryType: z.string().default("GITHUB"),
});

export const bindAgentSchema = z.object({
  agentTemplateId: z.string().uuid(),
  bindingName: z.string().min(2),
  roleInCapability: z.string().optional(),
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
