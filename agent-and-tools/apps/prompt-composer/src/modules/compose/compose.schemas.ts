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
  capability_id: z.string().max(180).optional(),
  capability_permissions: z.array(z.enum(["read", "invoke", "configure", "edit"])).default(["read", "invoke"]),
  read_only: z.boolean().default(false),
  provider_locked: z.boolean().default(false),
  provider_id: z.string().max(180).optional(),
  provider_manifest_version: z.string().max(120).optional(),
  provider_manifest_digest: z.string().max(160).optional(),
  provider_manifest_signature_key_id: z.string().max(180).optional(),
  provider_manifest_signed: z.boolean().optional(),
  source: z.enum(["local", "provider", "runtime", "provider_manifest", "url_document", "uploaded_document"]).default("local"),
  source_type: z.string().max(120).optional(),
  source_ref: z.string().max(1_000).optional(),
  version: z.string().max(80).optional(),
});

const effectiveCapabilitySchema = z.record(z.unknown()).refine(v => jsonCharLength(v) <= 12_000, "effective capability entry is too large");

export const composeSchema = z.object({
  agentTemplateId: z.string().uuid(),
  agentBindingId: z.string().uuid().optional(),
  capabilityId: z.string().uuid().optional(),
  // D3 — tenant that owns this prompt. OPTIONAL so every existing caller
  // keeps composing unchanged; when supplied it is stamped onto the
  // PromptAssembly row. Not a uuid() because tenant ids are not uniformly
  // uuids across the platform, and rejecting a caller's real tenant id on
  // a format technicality would lose the attribution we are trying to gain.
  tenantId: z.string().min(1).max(180).optional(),
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
  // Resolved Agent Profile capability snapshot. Direct compose callers that
  // do not pass toolDescriptors must provide this before Prompt Composer can
  // safely ask tool-service for dynamic tools under fail-closed governance.
  effectiveCapabilities: z.array(effectiveCapabilitySchema).max(128).optional(),
  // M52 — Pre-budgeted code-context package from mcp-server. When present,
  // Prompt Composer emits 7 CODE_* layers (TASK_INTENT, TARGET_SYMBOLS,
  // EDITABLE_SLICES, DEPENDENCY_SLICES, TYPE_CONTRACTS, TEST_SLICES,
  // CONTEXT_RECEIPT) IN PLACE OF the legacy monolithic CODE_CONTEXT layer.
  // Shape mirrors mcp-server's CodeContextPackage (src/mcp/code-context.ts).
  // Slice content lives only in-flight (in the assembled system prompt
  // emitted to mcp-server); the central PromptAssembly DB stores the
  // assembled text BUT the slice rows themselves are not separately
  // persisted, so this stays consistent with "private code in MCP".
  codeContextPackage: z.object({
    context_package_id: z.string(),
    task_intent: z.object({
      kind: z.enum(["code_modification", "code_read", "unknown"]),
      summary: z.string(),
    }),
    target_symbols: z.array(z.object({
      symbol: z.string(),
      file: z.string(),
      language: z.string(),
      start_line: z.number(),
      end_line: z.number(),
      reason: z.string(),
    })),
    editable_slices: z.array(z.object({
      file: z.string(),
      symbol: z.string(),
      start_line: z.number(),
      end_line: z.number(),
      content: z.string(),
      token_count: z.number(),
      content_hash: z.string(),
    })),
    dependency_slices: z.array(z.object({
      file: z.string(),
      symbol: z.string(),
      start_line: z.number(),
      end_line: z.number(),
      content: z.string(),
      token_count: z.number(),
      content_hash: z.string(),
      dependency_depth: z.number().optional(),
    })),
    test_slices: z.array(z.object({
      file: z.string(),
      symbol: z.string(),
      start_line: z.number(),
      end_line: z.number(),
      content: z.string(),
      token_count: z.number(),
      content_hash: z.string(),
    })),
    excluded_context: z.array(z.object({
      file: z.string(),
      symbol: z.string().optional(),
      reason: z.string(),
      estimated_tokens_avoided: z.number().optional(),
    })),
    optimization: z.object({
      raw_estimate: z.number(),
      optimized_estimate: z.number(),
      tokens_saved: z.number(),
      percent_saved: z.number(),
    }),
  }).optional(),
  // M61 Slice F — CapabilityWorldModel snapshot. Optional, capability-
  // scoped, byte-stable across workflows targeting the same repo.
  // When present, compose emits CODE_AGENT_RULES and CODE_WORLD_MODEL
  // layers ABOVE the M52 code-context layers so ambient capability
  // knowledge precedes the task-specific code slices.
  //
  // Caller is expected to pass exactly what's stored in agent-runtime's
  // CapabilityWorldModel row (see capabilities/world-model.service.ts).
  // The shape is intentionally narrow — we only render what's useful
  // for the agent, not every column of the DB row.
  worldModel: z.object({
    capabilityId: z.string(),
    primaryLanguage: z.string().nullable().optional(),
    buildSystem: z.string().nullable().optional(),
    testCommands: z.array(z.object({
      kind: z.string(),
      cmd: z.string(),
      cwd: z.string().optional(),
      expectedDurationSec: z.number().optional(),
      requiresNetwork: z.boolean().optional(),
    })).default([]),
    buildCommands: z.array(z.object({
      kind: z.string(),
      cmd: z.string(),
      cwd: z.string().optional(),
    })).default([]),
    agentRules: z.array(z.object({
      source: z.string(),
      content: z.string(),
      sha256: z.string().optional(),
    })).default([]),
    readmeSummary: z.string().nullable().optional(),
    // Mirrors agent-runtime's ArchitectureSlice shape (M61 Slice A).
    architectureSlice: z.object({
      rootPackages: z.array(z.object({
        path: z.string(),
        language: z.string().optional(),
        publicSymbols: z.array(z.string()).optional(),
      })).optional(),
      extras: z.record(z.unknown()).optional(),
    }).optional(),
    // Richer LLM-distilled grounding (world-model-distill) — surfaced in the
    // CODE_WORLD_MODEL prompt layer for the Design/Plan/Develop stages.
    codeConventions: z.array(z.object({
      topic: z.string(),
      rule: z.string(),
      source: z.string().optional(),
    })).default([]),
    entrypoints: z.array(z.object({
      kind: z.string(),
      target: z.string(),
      command: z.string().optional(),
    })).default([]),
    // Parent/delivery capabilities embed their children's world models BY
    // REFERENCE (agent-runtime fetches them on-demand from the hierarchy).
    childWorldModels: z.array(z.object({
      capabilityId: z.string(),
      name: z.string().nullable().optional(),
      primaryLanguage: z.string().nullable().optional(),
      readmeSummary: z.string().nullable().optional(),
      codeConventions: z.array(z.object({ topic: z.string(), rule: z.string(), source: z.string().optional() })).default([]),
      entrypoints: z.array(z.object({ kind: z.string(), target: z.string(), command: z.string().optional() })).default([]),
    })).default([]),
  }).optional(),
  // Layered world model — the role-scoped views context-fabric selected for THIS
  // agent, already narrowed and budgeted by agent-runtime's slice endpoint. The
  // composer renders what it is given and does not re-filter; deciding what a
  // role should read lives in one place, and it is not here.
  //
  // A SIBLING of worldModel rather than a field inside it: a capability with no
  // repository can have views (built from its description, knowledge artifacts
  // and children) while having no world model at all, and that is a valid input.
  worldModelViews: z.array(z.object({
    kind: z.string(),
    domainKey: z.string().optional(),
    title: z.string(),
    contentMd: z.string(),
    tokenEstimate: z.number().optional(),
    contentHash: z.string().nullable().optional(),
    /** Built against an older repo fingerprint. Rendered with a note rather than
     *  dropped — stale grounding beats none, and the reader can discount it. */
    stale: z.boolean().optional(),
  })).optional(),
  // M62 Slice D — LLMLingua-2 prompt compression. Opt-in per-layer.
  //
  // When `compression.enabled` is true, after all layers are assembled,
  // we walk the layer array and for each layer whose `layerType` is in
  // `layerKindsAllowed` AND whose estimated token count exceeds
  // `perLayerBudgetTokens`, we POST the contentSnapshot to
  // ${compressorUrl}/api/v1/compress with target_token=perLayerBudgetTokens.
  // The returned text replaces contentSnapshot and a compressionReceipt
  // stamp lands on the layer so consumers can audit.
  //
  // Default allowlist is intentionally narrow — compressing
  // CODE_EDITABLE_SLICES would corrupt diffs, compressing TOOL_CONTRACT
  // would scramble JSON schemas. Operators add layer kinds explicitly
  // when they've validated quality.
  //
  // Compressor failures (timeout / 4xx / network) are best-effort:
  // leave the layer untouched and surface a composer_warning. The
  // workflow never blocks on the compressor being down.
  compression: z.object({
    enabled: z.boolean().default(false),
    perLayerBudgetTokens: z.number().int().positive().max(8000).default(1500),
    layerKindsAllowed: z.array(z.string()).default([
      "CODE_AGENT_RULES",
      "RUNTIME_EVIDENCE",
    ]),
    compressorUrl: z.string().optional(),
    timeoutMs: z.number().int().positive().max(30_000).default(5_000),
  }).optional(),
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
