import fs from "fs";
import path from "path";
import { z } from "zod";
import { config } from "../config";
import { listConfiguredProviders } from "./client";
import { AppError } from "../shared/errors";

const CatalogEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  ready: z.boolean().optional(),
  default: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  costTier: z.enum(["mock", "low", "medium", "high"]).optional(),
  description: z.string().optional(),
});

export type LlmModelCatalogEntry = z.infer<typeof CatalogEntrySchema> & {
  label: string;
  ready: boolean;
  warnings: string[];
};

export type ResolvedModelConfig = {
  modelAlias?: string;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  warnings: string[];
};

function providerReady(provider: string): boolean {
  const row = listConfiguredProviders().find(p => p.name === provider.toLowerCase());
  return row?.ready ?? false;
}

function readCatalogSource(): unknown {
  if (config.MCP_LLM_MODEL_CATALOG_JSON?.trim()) {
    return JSON.parse(config.MCP_LLM_MODEL_CATALOG_JSON);
  }
  if (config.MCP_LLM_MODEL_CATALOG_PATH?.trim()) {
    const p = path.resolve(config.MCP_LLM_MODEL_CATALOG_PATH);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

function fallbackCatalog(): LlmModelCatalogEntry[] {
  return [{
    id: "default",
    label: "Mock offline",
    provider: "mock",
    model: "mock-fast",
    ready: true,
    default: true,
    maxOutputTokens: undefined,
    supportsTools: false,
    costTier: "mock",
    description: "Mock-only fallback used when external MCP model catalog config is missing or invalid.",
    warnings: [],
  }];
}

let cachedCatalog: { entries: LlmModelCatalogEntry[]; warnings: string[]; source: string } | null = null;

export function loadModelCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const warnings: string[] = [];
  try {
    const raw = readCatalogSource();
    if (!raw) {
      warnings.push("No external MCP model catalog was provided; using mock only.");
      cachedCatalog = { entries: fallbackCatalog(), warnings, source: "fallback-mock" };
      return cachedCatalog;
    }
    const parsed = z.array(CatalogEntrySchema).safeParse(raw);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.flatten().fieldErrors));
    }
    const entries = parsed.data.map((entry): LlmModelCatalogEntry => {
      const readyByProvider = providerReady(entry.provider);
      const ready = entry.ready === false ? false : readyByProvider;
      const entryWarnings = ready ? [] : [`Provider ${entry.provider} is not ready for ${entry.id}.`];
      return {
        ...entry,
        label: entry.label ?? `${entry.provider} / ${entry.model}`,
        ready,
        warnings: entryWarnings,
      };
    });
    if (entries.length === 0) {
      warnings.push("MCP model catalog was empty; using mock only.");
      cachedCatalog = { entries: fallbackCatalog(), warnings, source: "fallback-empty-mock" };
      return cachedCatalog;
    }
    if (!entries.some(e => e.default)) {
      entries[0] = { ...entries[0], default: true };
      warnings.push(`No default model was marked; using ${entries[0].id}.`);
    }
    cachedCatalog = { entries, warnings, source: config.MCP_LLM_MODEL_CATALOG_JSON ? "env-json" : "file" };
  } catch (err) {
    warnings.push(`Failed to load MCP model catalog; using mock only. ${err instanceof Error ? err.message : String(err)}`);
    cachedCatalog = { entries: fallbackCatalog(), warnings, source: "fallback-error-mock" };
  }
  return cachedCatalog;
}

export function defaultModelAlias(): string {
  return loadModelCatalog().entries.find(e => e.default)?.id ?? loadModelCatalog().entries[0]?.id ?? "default";
}

export function modelCatalogResponse() {
  const catalog = loadModelCatalog();
  return {
    source: catalog.source,
    defaultModelAlias: defaultModelAlias(),
    warnings: catalog.warnings,
    providers: listConfiguredProviders(),
    models: catalog.entries,
  };
}

export function resolveModelConfig(input: {
  modelAlias?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): ResolvedModelConfig {
  const catalog = loadModelCatalog();
  const warnings: string[] = [];
  const alias = input.modelAlias?.trim();
  if (alias) {
    const entry = catalog.entries.find(e => e.id === alias);
    if (!entry) warnings.push(`Alias ${alias} is not present in MCP's display catalog; llm-gateway will validate it.`);
    if (entry && !entry.ready) warnings.push(...entry.warnings);
    return {
      modelAlias: alias,
      provider: "gateway",
      model: entry?.model ?? alias,
      temperature: input.temperature,
      maxTokens: input.maxTokens ?? entry?.maxOutputTokens,
      warnings,
    };
  }

  if (input.provider || input.model) {
    throw new AppError("Raw MCP provider/model overrides are disabled; pass modelAlias", 400, "MODEL_ALIAS_REQUIRED", {
      provider: input.provider,
      model: input.model,
    });
  }

  const defaultEntry = catalog.entries.find(e => e.default) ?? catalog.entries[0];
  if (defaultEntry && !defaultEntry.ready) warnings.push(...defaultEntry.warnings);
  return {
    modelAlias: defaultEntry?.id,
    provider: "gateway",
    model: defaultEntry?.model ?? "gateway-default",
    temperature: input.temperature,
    maxTokens: input.maxTokens ?? defaultEntry?.maxOutputTokens,
    warnings,
  };
}
