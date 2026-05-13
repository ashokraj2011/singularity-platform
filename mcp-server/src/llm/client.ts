import { config } from "../config";
import { mockLlmRespond } from "./mock";
import { openaiRespond } from "./providers/openai";
import { anthropicRespond } from "./providers/anthropic";
import { copilotRespond } from "./providers/copilot";
import { LlmRequest, LlmResponse, LlmStreamHooks } from "./types";

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
  const provider = (req.provider || config.LLM_PROVIDER).toLowerCase();
  switch (provider) {
    case "mock":      return mockLlmRespond(req, hooks);
    case "openai":    return openaiRespond(req, hooks);
    case "anthropic": return anthropicRespond(req, hooks);
    case "copilot":   return copilotRespond(req, hooks);
    default:
      throw new Error(`unknown LLM provider: ${provider}. Supported: mock, openai, anthropic, copilot.`);
  }
}

/** Used by /healthz and the new GET /llm/providers route to surface
 *  which providers are configured (without leaking key material). */
export function listConfiguredProviders(): Array<{ name: string; ready: boolean; default_model: string }> {
  return [
    { name: "mock",      ready: true,                              default_model: config.LLM_MODEL },
    { name: "openai",    ready: Boolean(config.OPENAI_API_KEY),    default_model: config.OPENAI_DEFAULT_MODEL },
    { name: "anthropic", ready: Boolean(config.ANTHROPIC_API_KEY), default_model: config.ANTHROPIC_DEFAULT_MODEL },
    { name: "copilot",   ready: Boolean(config.COPILOT_TOKEN),     default_model: config.COPILOT_DEFAULT_MODEL },
  ];
}
