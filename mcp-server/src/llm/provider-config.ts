import fs from "fs";
import path from "path";
import { z } from "zod";
import { config } from "../config";

export const SupportedProviderSchema = z.enum(["mock", "openai", "openrouter", "anthropic", "copilot"]);
export type SupportedProvider = z.infer<typeof SupportedProviderSchema>;

const ProviderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  credentialEnv: z.string().min(1).optional(),
  supportsTools: z.boolean().optional(),
  costTier: z.enum(["mock", "low", "medium", "high"]).optional(),
  description: z.string().optional(),
}).passthrough();

const ProviderConfigSchema = z.object({
  defaultProvider: SupportedProviderSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  allowedProviders: z.array(SupportedProviderSchema).optional(),
  providers: z.record(ProviderSettingsSchema).optional(),
}).passthrough();

type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

type LoadedProviderConfig = {
  settings: ProviderConfig;
  source: string;
  warnings: string[];
};

export const SUPPORTED_PROVIDERS: SupportedProvider[] = ["mock", "openai", "openrouter", "anthropic", "copilot"];

let cached: LoadedProviderConfig | null = null;

function readConfigSource(): unknown {
  if (config.MCP_LLM_PROVIDER_CONFIG_JSON?.trim()) {
    return JSON.parse(config.MCP_LLM_PROVIDER_CONFIG_JSON);
  }
  if (config.MCP_LLM_PROVIDER_CONFIG_PATH?.trim()) {
    const p = path.resolve(config.MCP_LLM_PROVIDER_CONFIG_PATH);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

function envAllowedProviders(): SupportedProvider[] | undefined {
  const raw = config.MCP_ALLOWED_LLM_PROVIDERS?.trim();
  if (!raw) return undefined;
  const providers = raw
    .split(",")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
    .map(v => SupportedProviderSchema.safeParse(v))
    .filter((result): result is z.SafeParseSuccess<SupportedProvider> => result.success)
    .map(result => result.data);
  return providers.length ? providers : undefined;
}

export function loadProviderConfig(): LoadedProviderConfig {
  if (cached) return cached;
  const warnings: string[] = [];
  try {
    const raw = readConfigSource();
    if (!raw) {
      throw new Error("No platform LLM config provided (MCP_LLM_PROVIDER_CONFIG_JSON or MCP_LLM_PROVIDER_CONFIG_PATH is missing)");
    }
    const parsed = ProviderConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.flatten().fieldErrors));
    }
    cached = {
      settings: parsed.data,
      source: config.MCP_LLM_PROVIDER_CONFIG_JSON ? "env-json" : "file",
      warnings,
    };
    return cached;
  } catch (err) {
    warnings.push(`ConfigurationError: Failed to load MCP LLM provider config. Entering degraded state (only mock allowed). ${err instanceof Error ? err.message : String(err)}`);
    cached = {
      settings: { defaultProvider: "mock", allowedProviders: ["mock"] },
      source: "degraded-error",
      warnings,
    };
    return cached;
  }
}

export function providerSettings(provider: string): ProviderSettings {
  const parsed = SupportedProviderSchema.safeParse(provider.toLowerCase());
  if (!parsed.success) return {};
  return loadProviderConfig().settings.providers?.[parsed.data] ?? {};
}

export function configuredDefaultProvider(): SupportedProvider {
  return loadProviderConfig().settings.defaultProvider ?? config.LLM_PROVIDER;
}

export function providerDefaultModel(provider: string): string {
  const p = provider.toLowerCase();
  const setting = providerSettings(p).defaultModel;
  if (setting) return setting;
  switch (p) {
    case "mock": return config.LLM_MODEL || "mock-fast";
    case "openai": return config.OPENAI_DEFAULT_MODEL;
    case "openrouter": return "openai/gpt-4o-mini";
    case "anthropic": return config.ANTHROPIC_DEFAULT_MODEL;
    case "copilot": return config.COPILOT_DEFAULT_MODEL;
    default: return config.LLM_MODEL;
  }
}

export function configuredDefaultModel(): string {
  const settings = loadProviderConfig().settings;
  return settings.defaultModel ?? providerDefaultModel(configuredDefaultProvider());
}

export function providerBaseUrl(provider: string): string {
  const p = provider.toLowerCase();
  const setting = providerSettings(p).baseUrl;
  if (setting) return setting;
  switch (p) {
    case "openai": return config.OPENAI_BASE_URL;
    case "openrouter": return config.OPENROUTER_BASE_URL;
    case "anthropic": return config.ANTHROPIC_BASE_URL;
    case "copilot": return config.COPILOT_BASE_URL;
    default: return "";
  }
}

export function isProviderAllowedByConfig(provider: string): boolean {
  const parsed = SupportedProviderSchema.safeParse(provider.toLowerCase());
  if (!parsed.success) return false;
  const settings = loadProviderConfig().settings;
  if (settings.providers?.[parsed.data]?.enabled === false) return false;
  const allowed = settings.allowedProviders;
  return !allowed?.length || allowed.includes(parsed.data);
}

export function providerCredentialConfigured(provider: string): boolean {
  const p = provider.toLowerCase();
  if (p === "mock") return true;
  const credentialEnv = providerCredentialEnvName(p);
  if (credentialEnv && providerSettings(p).credentialEnv) return Boolean(process.env[credentialEnv]);
  switch (p) {
    case "openai": return Boolean(config.OPENAI_API_KEY);
    case "openrouter": return Boolean(config.OPENROUTER_API_KEY);
    case "anthropic": return Boolean(config.ANTHROPIC_API_KEY);
    case "copilot": return Boolean(config.COPILOT_TOKEN);
    default: return false;
  }
}

export function providerCredentialEnvName(provider: string): string {
  const p = provider.toLowerCase();
  const configured = providerSettings(p).credentialEnv;
  if (configured) return configured;
  switch (p) {
    case "openai": return "OPENAI_API_KEY";
    case "openrouter": return "OPENROUTER_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "copilot": return "COPILOT_TOKEN";
    default: return "";
  }
}

export function providerConfigSummary() {
  const loaded = loadProviderConfig();
  return {
    source: loaded.source,
    warnings: loaded.warnings,
    defaultProvider: configuredDefaultProvider(),
    defaultModel: configuredDefaultModel(),
    allowedProviders: loaded.settings.allowedProviders ?? [],
  };
}
