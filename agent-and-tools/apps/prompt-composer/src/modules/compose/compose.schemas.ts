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

const toolDescriptorSchema = z.object({
  name: z.string().min(1).max(180),
  description: z.string().max(4_000).default(""),
  natural_language: z.string().max(4_000).optional(),
  input_schema: z.record(z.unknown()).default({ type: "object" }).refine(v => jsonCharLength(v) <= 12_000, "tool input_schema is too large"),
  execution_target: z.enum(["LOCAL", "SERVER"]).default("LOCAL"),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("LOW"),
  requires_approval: z.boolean().default(false),
  version: z.string().max(80).optional(),
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
  // Canonical run-level tools. Context Fabric passes this after resolving
  // Tool Service once, so Prompt Composer renders the same descriptors MCP
  // will receive instead of doing a second discovery pass.
  toolDescriptors: z.array(toolDescriptorSchema).max(64).optional(),
  // M44 Slice C — When true, the TOOL_CONTRACT layer omits the full JSON
  // input_schema dump because the same schema is already sent to the LLM
  // as a real tool descriptor (Anthropic/OpenAI `tools` parameter). Keeping
  // name + purpose + risk + execution_target in prose still anchors
  // model behaviour without paying the schema cost twice (~200-500 tokens
  // per tool, ~20 tools per run = 5K+ duplicated tokens per call).
  // Callers that DON'T pass tools through the structured channel
  // (text-only models) should leave this false so they still see schemas.
  compactToolContracts: z.boolean().default(false),
  previewOnly: z.boolean().default(false),
  // M25.5 C6 — operator escape hatch. When true, lookupCapsule() is skipped
  // (cold path runs every time) AND no fresh capsule is stored. Use this
  // when editing knowledge artifacts and you need to see the live retrieval
  // result, not a stale compiled paragraph. Set via `?nocache=1` query
  // param or `Bypass-Cache: 1` header at the route level.
  bypassCache: z.boolean().default(false),
});
export type ComposeInput = z.infer<typeof composeSchema>;
