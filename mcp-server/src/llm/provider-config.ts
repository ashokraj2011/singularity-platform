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

function settingsFor(provider: SupportedProvider): ProviderSettings | undefined {
  return loadProviderConfig().settings.providers?.[provider];
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
  return settingsFor(parsed.data) ?? {};
}

export function configuredDefaultProvider(): SupportedProvider {
  return loadProviderConfig().settings.defaultProvider ?? "mock";
}

export function providerDefaultModel(provider: string): string {
  const p = provider.toLowerCase();
  const setting = providerSettings(p).defaultModel;
  if (setting) return setting;
  return p === "mock" ? "mock-fast" : "";
}

export function configuredDefaultModel(): string {
  const settings = loadProviderConfig().settings;
  return settings.defaultModel ?? (providerDefaultModel(configuredDefaultProvider()) || "mock-fast");
}

export function isProviderAllowedByConfig(provider: string): boolean {
  const parsed = SupportedProviderSchema.safeParse(provider.toLowerCase());
  if (!parsed.success) return false;
  const settings = loadProviderConfig().settings;
  const providerConfig = settingsFor(parsed.data);
  if (parsed.data !== "mock" && !providerConfig) return false;
  if (providerConfig?.enabled === false) return false;
  const allowed = settings.allowedProviders;
  return !allowed?.length || allowed.includes(parsed.data);
}

// M33 — credential presence is owned by llm-gateway-service. The mcp-server
// no longer reads provider API keys directly. `providerCredentialConfigured`
// and `providerCredentialEnvName` were retired here; introspect via the
// gateway's /llm/providers endpoint instead (see client.refreshGatewayProviderStatus).

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
