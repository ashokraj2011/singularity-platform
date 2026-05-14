import { mockLlmRespond } from "./mock";
import { openaiRespond, openrouterRespond } from "./providers/openai";
import { anthropicRespond } from "./providers/anthropic";
import { copilotRespond } from "./providers/copilot";
import { LlmRequest, LlmResponse, LlmStreamHooks } from "./types";
import {
  SUPPORTED_PROVIDERS,
  configuredDefaultProvider,
  isProviderAllowedByConfig,
  loadProviderConfig,
  providerCredentialConfigured,
  providerCredentialEnvName,
  providerDefaultModel,
  providerSettings,
} from "./provider-config";

export function isProviderAllowed(provider: string): boolean {
  return isProviderAllowedByConfig(provider);
}

/**
 * M11 follow-up — embedded LLM gateway.
 *
 * Provider keys live in THIS MCP server's environment (customer's local
 * machine) and never leave the local boundary — by design, so the platform
 * stays LLM-agnostic and the customer chooses + pays for their own provider.
 *
 * Routes by `req.provider` (or `config.LLM_PROVIDER` as default). Adding
 * a new provider is purely additive: drop a file under src/llm/providers/
 * and switch on the name here.
 */
export async function llmRespond(req: LlmRequest, hooks?: LlmStreamHooks): Promise<LlmResponse> {
  const provider = (req.provider || configuredDefaultProvider()).toLowerCase();
  if (!isProviderAllowed(provider)) {
    throw new Error(`LLM provider is disabled by MCP provider config: ${provider}`);
  }
  switch (provider) {
    case "mock":      return mockLlmRespond(req, hooks);
    case "openai":    return openaiRespond(req, hooks);
    case "openrouter": return openrouterRespond(req, hooks);
    case "anthropic": return anthropicRespond(req, hooks);
    case "copilot":   return copilotRespond(req, hooks);
    default:
      throw new Error(`unknown LLM provider: ${provider}. Supported: mock, openai, openrouter, anthropic, copilot.`);
  }
}

/** Used by /healthz and the new GET /llm/providers route to surface
 *  which providers are configured (without leaking key material). */
export type ConfiguredProviderInfo = {
  name: string;
  ready: boolean;
  default_model: string;
  allowed: boolean;
  enabled: boolean;
  source: string;
  warnings: string[];
};

export function listConfiguredProviders(): ConfiguredProviderInfo[] {
  const loaded = loadProviderConfig();
  return SUPPORTED_PROVIDERS.map(provider => {
    const settings = providerSettings(provider);
    const allowed = isProviderAllowed(provider);
    const hasCredential = providerCredentialConfigured(provider);
    const enabled = settings.enabled !== false;
    const warnings: string[] = [];
    if (!enabled) warnings.push("Disabled by MCP LLM provider config.");
    if (!allowed) warnings.push("Blocked by MCP provider allowlist.");
    if (!hasCredential && provider !== "mock") {
      warnings.push(`Missing credential env ${providerCredentialEnvName(provider)}.`);
    }
    return {
      name: provider,
      ready: enabled && allowed && hasCredential,
      default_model: providerDefaultModel(provider),
      allowed,
      enabled,
      source: loaded.source,
      warnings,
    };
  });
}
