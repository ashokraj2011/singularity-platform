import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(7000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MCP_BEARER_TOKEN: z.string().min(16),

  // ── LLM provider router (M11 follow-up) ─────────────────────────────────────
  // Default provider when a request doesn't specify one. Per-request
  // overrides via LlmRequest.provider.
  LLM_PROVIDER: z.enum(["mock", "openai", "anthropic", "copilot"]).default("mock"),
  LLM_MODEL: z.string().default("mock-fast"),

  // OpenAI Chat Completions (https://api.openai.com/v1/chat/completions).
  OPENAI_API_KEY:  z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),

  // Anthropic Messages API (https://api.anthropic.com/v1/messages).
  ANTHROPIC_API_KEY:  z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  ANTHROPIC_VERSION:  z.string().default("2023-06-01"),

  // GitHub Copilot Headless. OpenAI-compatible chat-completions surface
  // hosted at api.githubcopilot.com, gated by a Copilot subscription token.
  // Token is short-lived (~30 min); operator refreshes via gh auth or a
  // companion mint script.
  COPILOT_TOKEN:    z.string().optional(),
  COPILOT_BASE_URL: z.string().default("https://api.githubcopilot.com"),

  // Default per-provider model when LlmRequest.model is empty.
  OPENAI_DEFAULT_MODEL:    z.string().default("gpt-4o-mini"),
  ANTHROPIC_DEFAULT_MODEL: z.string().default("claude-sonnet-4-6"),
  COPILOT_DEFAULT_MODEL:   z.string().default("gpt-4o"),

  MAX_AGENT_STEPS: z.coerce.number().int().positive().default(12),
  TIMEOUT_SEC: z.coerce.number().int().positive().default(240),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[mcp-server] invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
