import { z } from "zod";

function jsonCharLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export const artifactSchema = z.object({
  consumableId: z.string().optional(),
  consumableType: z.string().optional(),
  role: z.enum(["INPUT", "CONTEXT", "REFERENCE"]).default("CONTEXT"),
  label: z.string().min(1).max(160),
  mediaType: z.string().optional(),
  content: z.string().max(12_000).optional(),
  minioRef: z.string().optional(),
  excerpt: z.string().max(3_000).optional(),
});
export type ArtifactInput = z.infer<typeof artifactSchema>;

export const layerOverrideSchema = z.object({
  layerType: z.string().default("EXECUTION_OVERRIDE"),
  content: z.string().min(1).max(4_000),
});

export const composeSchema = z.object({
  agentTemplateId: z.string().uuid(),
  agentBindingId: z.string().uuid().optional(),
  capabilityId: z.string().uuid().optional(),
  task: z.string().min(1).max(4_000),
  workflowContext: z.object({
    instanceId: z.string().min(1),
    nodeId: z.string().min(1),
    phaseId: z.string().optional(),
    // M28 spine-2 — TraceId is the run evidence spine. Optional for back-compat;
    // when absent the composer derives it from instanceId at persist time.
    traceId: z.string().optional(),
    vars: z.record(z.unknown()).default({}).refine(v => jsonCharLength(v) <= 8_000, "workflowContext.vars is too large; pass compact variables only"),
    globals: z.record(z.unknown()).default({}).refine(v => jsonCharLength(v) <= 8_000, "workflowContext.globals is too large; pass compact globals only"),
    priorOutputs: z.record(z.unknown()).default({}).refine(v => jsonCharLength(v) <= 12_000, "workflowContext.priorOutputs is too large; pass summaries and artifact references instead of full outputs"),
  }),
  artifacts: z.array(artifactSchema).default([]),
  overrides: z.object({
    additionalLayers: z.array(layerOverrideSchema).default([]),
    systemPromptAppend: z.string().max(2_000).optional(),
    extraContext: z.string().max(4_000).optional(),
  }).default({ additionalLayers: [] }),
  modelOverrides: z.object({
    modelAlias: z.string().min(1).max(80).optional(),
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
  // M25.5 C6 — operator escape hatch. When true, lookupCapsule() is skipped
  // (cold path runs every time) AND no fresh capsule is stored. Use this
  // when editing knowledge artifacts and you need to see the live retrieval
  // result, not a stale compiled paragraph. Set via `?nocache=1` query
  // param or `Bypass-Cache: 1` header at the route level.
  bypassCache: z.boolean().default(false),
});
export type ComposeInput = z.infer<typeof composeSchema>;
