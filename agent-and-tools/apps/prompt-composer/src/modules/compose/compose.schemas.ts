import { z } from "zod";

export const artifactSchema = z.object({
  consumableId: z.string().optional(),
  consumableType: z.string().optional(),
  role: z.enum(["INPUT", "CONTEXT", "REFERENCE"]).default("CONTEXT"),
  label: z.string().min(1),
  mediaType: z.string().optional(),
  content: z.string().optional(),
  minioRef: z.string().optional(),
  excerpt: z.string().optional(),
});
export type ArtifactInput = z.infer<typeof artifactSchema>;

export const layerOverrideSchema = z.object({
  layerType: z.string().default("EXECUTION_OVERRIDE"),
  content: z.string().min(1),
});

export const composeSchema = z.object({
  agentTemplateId: z.string().uuid(),
  agentBindingId: z.string().uuid().optional(),
  capabilityId: z.string().uuid().optional(),
  task: z.string().min(1),
  workflowContext: z.object({
    instanceId: z.string().min(1),
    nodeId: z.string().min(1),
    phaseId: z.string().optional(),
    vars: z.record(z.unknown()).default({}),
    globals: z.record(z.unknown()).default({}),
    priorOutputs: z.record(z.unknown()).default({}),
  }),
  artifacts: z.array(artifactSchema).default([]),
  overrides: z.object({
    additionalLayers: z.array(layerOverrideSchema).default([]),
    systemPromptAppend: z.string().optional(),
    extraContext: z.string().optional(),
  }).default({ additionalLayers: [] }),
  modelOverrides: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxOutputTokens: z.number().int().optional(),
  }).default({}),
  contextPolicy: z.object({
    optimizationMode: z.string().optional(),
    maxContextTokens: z.number().int().optional(),
    compareWithRaw: z.boolean().optional(),
    knowledgeTopK: z.number().int().min(0).max(50).optional(),
    memoryTopK: z.number().int().min(0).max(50).optional(),
    codeTopK: z.number().int().min(0).max(50).optional(),
    maxLayerChars: z.number().int().min(500).max(100_000).optional(),
    maxPromptChars: z.number().int().min(2_000).max(500_000).optional(),
  }).default({}),
  toolDiscovery: z.object({
    enabled: z.boolean().default(true),
    riskMax: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    limit: z.number().int().default(8),
  }).default({ enabled: true, riskMax: "medium", limit: 8 }),
  previewOnly: z.boolean().default(false),
});
export type ComposeInput = z.infer<typeof composeSchema>;
