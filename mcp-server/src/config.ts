import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(7000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MCP_BEARER_TOKEN: z.string().min(16),

  // ── M33 — Central LLM Gateway ───────────────────────────────────────────
  // Every LLM call from mcp-server routes through the central
  // `llm-gateway-service` (context-fabric, port 8001). Provider keys live
  // ONLY in the gateway; mcp-server holds nothing more than the gateway
  // URL + an optional service bearer. There is no provider fallback chain;
  // gateway errors propagate. Set LLM_GATEWAY_URL=mock for in-process
  // unit tests that don't want a live gateway container.
  LLM_GATEWAY_URL:        z.string().min(1),
  LLM_GATEWAY_BEARER:     z.string().optional(),
  LLM_GATEWAY_TIMEOUT_SEC: z.coerce.number().int().positive().default(240),

  // External MCP-side provider config (display-only after M33). The gateway
  // owns the authoritative provider list; mcp-server reads this file only
  // to render /llm/providers + /llm/models introspection on its own surface.
  MCP_ALLOWED_LLM_PROVIDERS: z.string().optional(),
  MCP_LLM_PROVIDER_CONFIG_JSON: z.string().optional(),
  MCP_LLM_PROVIDER_CONFIG_PATH: z.string().optional(),
  MCP_LLM_MODEL_CATALOG_JSON: z.string().optional(),
  MCP_LLM_MODEL_CATALOG_PATH: z.string().optional(),

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
  MCP_WORKITEM_WORKSPACES_ROOT: z.string().optional(),
  MCP_WORK_BRANCH_PUSH_ON_FINISH: z.coerce.boolean().default(false),
  MCP_WORK_BRANCH_PUSH_REMOTE: z.string().default("origin"),
  MCP_AUTO_CHECKOUT_SOURCE: z.coerce.boolean().default(true),
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

// M35.1 — production-class envs refuse to start with weak secrets.
// Mirrors the @agentandtools/shared assertProductionSecret helper used by
// agent-service / tool-service / agent-runtime / prompt-composer.
// Duplicated here because mcp-server lives outside the agent-and-tools
// workspace and can't cleanly import that package.
function assertProductionSecretLocal(name: string, value: string | undefined, minLength = 32): void {
  const env = (process.env.NODE_ENV ?? "development").toLowerCase();
  if (!["production", "prod", "staging", "perf"].includes(env)) return;
  const KNOWN_BAD = new Set([
    "dev-secret-change-in-prod",
    "dev-secret-change-in-prod-min-32-chars!!",
    "changeme_dev_only_min_32_chars_long!!",
    "demo-bearer-token-must-be-min-16-chars",
    "dev-audit-gov-service-token",
    "changeme",
    "test-secret",
  ]);
  const v = value ?? "";
  const reasons: string[] = [];
  if (v.length === 0) reasons.push("unset");
  else if (v.length < minLength) reasons.push(`shorter than ${minLength} chars (got ${v.length})`);
  if (KNOWN_BAD.has(v)) reasons.push("matches a known development default");
  if (reasons.length > 0) {
    console.error(`FATAL: ${name} is unsafe for NODE_ENV=${env}: ${reasons.join("; ")}. Set ${name} to a strong random value (${minLength}+ chars) and restart.`);
    process.exit(1);
  }
}
assertProductionSecretLocal("MCP_BEARER_TOKEN", parsed.data.MCP_BEARER_TOKEN, 16);

export const config = parsed.data;
