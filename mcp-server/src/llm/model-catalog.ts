import fs from "fs";
import path from "path";
import { z } from "zod";
import { config } from "../config";
import { listConfiguredProviders } from "./client";
import { AppError } from "../shared/errors";
import { configuredDefaultModel, configuredDefaultProvider } from "./provider-config";

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

function defaultModelForProvider(provider: string): string {
  const row = listConfiguredProviders().find(p => p.name === provider.toLowerCase());
  return row?.default_model ?? config.LLM_MODEL;
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
  const provider = configuredDefaultProvider();
  return [{
    id: "default",
    label: `${provider} / ${configuredDefaultModel() || defaultModelForProvider(provider)}`,
    provider,
    model: configuredDefaultModel() || defaultModelForProvider(provider),
    ready: providerReady(provider),
    default: true,
    maxOutputTokens: undefined,
    supportsTools: provider !== "mock",
    costTier: provider === "mock" ? "mock" : "medium",
    description: "Fallback model from LLM_PROVIDER and LLM_MODEL.",
    warnings: providerReady(provider) ? [] : [`Provider ${provider} is missing required credentials.`],
  }];
}

let cachedCatalog: { entries: LlmModelCatalogEntry[]; warnings: string[]; source: string } | null = null;

export function loadModelCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const warnings: string[] = [];
  try {
    const raw = readCatalogSource();
    if (!raw) {
      cachedCatalog = { entries: fallbackCatalog(), warnings, source: "fallback-env" };
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
      warnings.push("MCP model catalog was empty; using fallback env default.");
      cachedCatalog = { entries: fallbackCatalog(), warnings, source: "fallback-empty" };
      return cachedCatalog;
    }
    if (!entries.some(e => e.default)) {
      entries[0] = { ...entries[0], default: true };
      warnings.push(`No default model was marked; using ${entries[0].id}.`);
    }
    cachedCatalog = { entries, warnings, source: config.MCP_LLM_MODEL_CATALOG_JSON ? "env-json" : "file" };
  } catch (err) {
    warnings.push(`Failed to load MCP model catalog; using fallback env default. ${err instanceof Error ? err.message : String(err)}`);
    cachedCatalog = { entries: fallbackCatalog(), warnings, source: "fallback-error" };
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
    if (!entry) {
      throw new AppError(`Unknown MCP model alias: ${alias}`, 400, "MODEL_ALIAS_UNKNOWN", {
        alias,
        availableAliases: catalog.entries.map(e => e.id),
      });
    }
    if (!entry.ready) {
      throw new AppError(`MCP model alias is not ready: ${alias}`, 400, "MODEL_ALIAS_NOT_READY", {
        alias,
        warnings: entry.warnings,
      });
    }
    return {
      modelAlias: entry.id,
      provider: entry.provider,
      model: entry.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens ?? entry.maxOutputTokens,
      warnings,
    };
  }

  if (input.provider || input.model) {
    const provider = input.provider ?? config.LLM_PROVIDER;
    const ready = providerReady(provider);
    if (!ready) warnings.push(`Provider ${provider} is not marked ready by MCP.`);
    return {
      provider,
      model: input.model ?? defaultModelForProvider(provider),
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      warnings,
    };
  }

  const defaultEntry = catalog.entries.find(e => e.default) ?? catalog.entries[0];
  if (!defaultEntry.ready) {
    throw new AppError(`Default MCP model alias is not ready: ${defaultEntry.id}`, 400, "MODEL_ALIAS_NOT_READY", {
      alias: defaultEntry.id,
      warnings: defaultEntry.warnings,
    });
  }
  return {
    modelAlias: defaultEntry.id,
    provider: defaultEntry.provider,
    model: defaultEntry.model,
    temperature: input.temperature,
    maxTokens: input.maxTokens ?? defaultEntry.maxOutputTokens,
    warnings,
  };
}
