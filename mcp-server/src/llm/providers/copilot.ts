/**
 * M11 follow-up — GitHub Copilot Headless provider.
 *
 * Routes through the same OpenAI-compatible chat-completions surface that
 * VS Code's Copilot extension uses (api.githubcopilot.com). Behaviour is
 * identical to OpenAI except for:
 *   - base URL (api.githubcopilot.com)
 *   - extra `editor-version` / `editor-plugin-version` / `copilot-integration-id`
 *     headers required by the proxy
 *   - bearer token comes from the operator (env COPILOT_TOKEN). Tokens are
 *     short-lived (~30 min); operator refreshes via `gh auth token` or a
 *     companion script. We do NOT refresh here — failures bubble up so the
 *     operator notices.
 *
 * Models exposed by Copilot include gpt-4o, gpt-4o-mini, claude-3.5-sonnet,
 * claude-3.7-sonnet, o1, o1-mini, o3-mini. Tool-calling support varies per
 * model (gpt-4o & claude-3.5-sonnet do; o1 family does NOT).
 */
import type { LlmRequest, LlmResponse, LlmStreamHooks } from "../types";
import { config } from "../../config";
import { callOpenAiCompatible } from "./openai";
import { providerBaseUrl, providerDefaultModel } from "../provider-config";

export async function copilotRespond(req: LlmRequest, hooks?: LlmStreamHooks): Promise<LlmResponse> {
  if (!config.COPILOT_TOKEN) throw new Error("COPILOT_TOKEN is not configured");
  return callOpenAiCompatible({
    baseUrl: providerBaseUrl("copilot"),
    apiKey:  config.COPILOT_TOKEN,
    model:   req.model || providerDefaultModel("copilot"),
    request: req,
    hooks,
    extraHeaders: {
      // These mirror what the official Copilot extensions send; the proxy
      // rejects requests without an editor identity. Values are arbitrary
      // strings — we declare ourselves as Singularity MCP.
      "editor-version":         "Singularity-MCP/0.1.0",
      "editor-plugin-version":  "singularity-mcp/0.1.0",
      "copilot-integration-id": "vscode-chat",
      "openai-intent":          "conversation-panel",
    },
  });
}
