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
  LLM_PROVIDER: z.enum(["mock", "openai", "openrouter", "anthropic", "copilot"]).default("mock"),
  LLM_MODEL: z.string().default("mock-fast"),
  MCP_LLM_MODEL_CATALOG_JSON: z.string().optional(),
  MCP_LLM_MODEL_CATALOG_PATH: z.string().optional(),

  // OpenAI Chat Completions (https://api.openai.com/v1/chat/completions).
  OPENAI_API_KEY:  z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  // Compatibility with context-fabric/.env naming so local demo stacks can
  // share one provider secret without duplicating it into multiple files.
  OPENAI_COMPATIBLE_API_KEY:  z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),

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

  // M16 — sandbox root for the real fs/git tools. All paths must resolve
  // strictly inside this dir; absolute paths and `..` traversal are rejected.
  // Default is the workdir; ops can mount a host directory in via docker-compose
  // and point this at it.
  MCP_SANDBOX_ROOT: z.string().default("/workspace"),
  MCP_AST_DB_PATH: z.string().optional(),
  MCP_AST_MAX_FILE_BYTES: z.coerce.number().int().positive().default(200_000),
  MCP_AST_MAX_WORKSPACE_BYTES: z.coerce.number().int().positive().default(24_000_000),
  // M27.5 — symbol cap. When the on-disk SQLite grows past this many rows
  // we LRU-evict the oldest-indexed files until back under cap. Tune up for
  // monorepos; tune down on laptops with constrained disk.
  MCP_AST_MAX_SYMBOLS: z.coerce.number().int().positive().default(250_000),
  MCP_WORK_BRANCH_PREFIX: z.string().default("sg"),
  MCP_AUDIT_LOG_PATH: z.string().optional(),
  MCP_AUDIT_RESTORE_LIMIT: z.coerce.number().int().positive().default(5000),

  // Context Fabric internal adapter used when the LLM selects a SERVER-target
  // tool. MCP remains the agent loop owner, but governed server tools still
  // execute through Context Fabric + tool-service.
  CONTEXT_FABRIC_URL: z.string().default("http://localhost:8000"),
  CONTEXT_FABRIC_SERVICE_TOKEN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[mcp-server] invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  OPENAI_API_KEY: parsed.data.OPENAI_API_KEY || parsed.data.OPENAI_COMPATIBLE_API_KEY,
  OPENAI_BASE_URL: parsed.data.OPENAI_BASE_URL || parsed.data.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1",
};
