import { config } from "../config";
import { mockLlmRespond } from "./mock";
import { LlmRequest, LlmResponse } from "./types";

/**
 * Provider router. v0 ships only the deterministic mock provider. Real
 * providers (openai, anthropic, openrouter) are added by importing their
 * SDKs and routing on `req.provider` (or `config.LLM_PROVIDER` as default).
 *
 * Provider keys would live in this MCP server's environment — never in
 * Singularity's cloud — so adding a real provider is purely additive: drop
 * a new file under src/llm/ and switch on the provider name here.
 */
export async function llmRespond(req: LlmRequest): Promise<LlmResponse> {
  const provider = req.provider || config.LLM_PROVIDER;
  if (provider === "mock") return mockLlmRespond(req);
  throw new Error(`provider '${provider}' not implemented in v0 (only 'mock' is supported)`);
}
