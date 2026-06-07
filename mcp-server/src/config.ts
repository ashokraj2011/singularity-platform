import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// M68.3 — Env-var boolean parser. `z.coerce.boolean()` is BROKEN for
// string inputs: it just calls `Boolean(x)` which treats ANY non-empty
// string as true, so `FORMAL_VERIFICATION_ENABLED=false` got coerced to
// `true` and the gate could not be turned off via env. This helper
// preserves explicit string semantics: "true"/"1"/"yes"/"on" → true,
// "false"/"0"/"no"/"off"/"" → false. Defaults to the provided value
// when the env is unset. Use everywhere a env-string boolean is read.
function envBool(defaultValue: boolean): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined> {
  return z.string().optional().transform((raw) => {
    if (raw === undefined || raw === null) return defaultValue;
    const trimmed = String(raw).trim().toLowerCase();
    if (trimmed === "") return defaultValue;
    if (["true", "1", "yes", "on"].includes(trimmed)) return true;
    if (["false", "0", "no", "off"].includes(trimmed)) return false;
    return defaultValue;
  });
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(7000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MCP_BEARER_TOKEN: z.string().min(16),
  MCP_SESSION_JWT_SECRET: z.string().optional(),
  MCP_SESSION_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(12 * 60 * 60),
  MCP_SESSION_TOKEN_ISSUER: z.string().default("singularity-mcp"),

  // ── ToolInvocationGrant — defence-in-depth over the policy-dumb runner ───
  // /mcp/tool-run only checks the bearer scope; the bearer proves "a caller in
  // IAM may talk to MCP" but NOT that this specific (tool, args, stage/phase)
  // was authorized by Context Fabric's governed loop. A leaked/over-scoped
  // bearer could therefore dispatch any tool — including mutating ones. When
  // enabled, MCP requires a CF-signed grant for mutating/high-risk tools and
  // verifies its signature, expiry, nonce (replay), and tool/args binding.
  //
  // TOOL_GRANT_SIGNING_SECRET — shared HMAC key; MUST equal context-fabric's
  //   TOOL_GRANT_SIGNING_SECRET. Optional so dev/test boot without it (in
  //   which case only mode=off is valid; see the assertion below).
  TOOL_GRANT_SIGNING_SECRET: z.string().optional(),
  // Enforcement mode (flag-gated rollout, default off = pre-hardening shape):
  //   off     — grants ignored entirely. Backward compatible.
  //   grace   — rollout window: if a grant is PRESENT it must be valid
  //             (reject tampered/expired/replayed/mismatched), but a MISSING
  //             grant is allowed (logged). Lets callers that haven't shipped
  //             grant-minting yet keep working while you watch the logs.
  //   enforce — mutating/high-risk tools REQUIRE a valid grant; missing or
  //             invalid → 403. Read-only tools are never gated.
  MCP_TOOL_GRANT_MODE: z.enum(["off", "grace", "enforce"]).default("off"),
  // Tool registry categories that require a grant under grace/enforce. The
  // genuinely state-changing + arbitrary-execution categories. Read-only ones
  // (read/analyzer/verify_meta) are intentionally excluded so the rollout
  // never blocks safe tools. Comma-separated; parsed below.
  MCP_TOOL_GRANT_REQUIRED_CATEGORIES: z.string().default("mutate,finalize,run"),
  // Allowance for clock drift between CF (issuer) and MCP (verifier) when
  // checking issuedAt/expiresAt, in seconds.
  MCP_TOOL_GRANT_CLOCK_SKEW_SEC: z.coerce.number().int().nonnegative().default(30),

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

  // ── Phased Agent Reasoning Model (v4) ──────────────────────────────────
  // Behind a flag for safe rollout. When false (default), runLoop uses the
  // existing flat ReAct loop unchanged — zero risk. When true, runLoop wraps
  // step iteration in a six-phase state machine (PLAN_DRAFT → EXPLORE →
  // PLAN_CONFIRM → ACT → VERIFY → FINALIZE) with per-phase tool allowlists,
  // path-coverage enforcement, and a pinned phase frame. See
  // /Users/ashokraj/.claude/plans/immutable-sniffing-quiche.md for the design.
  MCP_AGENT_PHASES_ENABLED: envBool(false),

  // M43 Slice 3 — Deterministic verification gate. When enabled, runs that
  // produced code changes but no verification receipt (or explicit
  // verification_unavailable receipt) are marked with
  // `correlation.verificationCoverage.gap = true`. The workgraph-side gate
  // can then refuse approval (NEEDS_REWORK). Default off so the gate ships
  // as a signal first, becomes blocking once we have a feel for false
  // positives.
  MCP_DETERMINISTIC_VERIFICATION_GATE_ENABLED: envBool(false),

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
  MCP_WORK_BRANCH_PUSH_ON_FINISH: envBool(false),
  MCP_WORK_BRANCH_PUSH_REMOTE: z.string().default("origin"),
  MCP_GIT_PUSH_ENABLED: envBool(false),
  MCP_GIT_AUTH_MODE: z.enum(["disabled", "ssh", "token"]).default("disabled"),
  MCP_GIT_PUSH_REMOTE: z.string().default("origin"),
  MCP_GIT_TOKEN_ENV: z.string().default("GITHUB_TOKEN"),
  MCP_GIT_TOKEN: z.string().optional(),
  MCP_GIT_USERNAME: z.string().default("x-access-token"),
  MCP_GIT_SSH_KEY_PATH: z.string().optional(),
  MCP_AUTO_CHECKOUT_SOURCE: envBool(true),
  MCP_SOURCE_CACHE_ROOT: z.string().optional(),
  MCP_WORKSPACE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  MCP_WORKSPACE_LOCK_STALE_MS: z.coerce.number().int().positive().default(30 * 60_000),
  MCP_WORKSPACE_GC_ENABLED: envBool(true),
  MCP_WORKSPACE_GC_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  MCP_WORKSPACE_DISK_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(0),
  MCP_AUDIT_LOG_PATH: z.string().optional(),
  MCP_AUDIT_RESTORE_LIMIT: z.coerce.number().int().positive().default(5000),

  // Local command execution. Production/default Docker runs use a dedicated
  // runner service; process mode is reserved for unit tests and explicit dev
  // override so MCP never silently falls back to host execution.
  MCP_COMMAND_EXECUTION_MODE: z.enum(["container", "process"]).optional(),
  MCP_RUNNER_URL: z.string().default("http://mcp-sandbox-runner:7110"),
  MCP_RUNNER_TOKEN: z.string().optional(),
  MCP_RUNNER_HOST_WORKSPACE_PATH: z.string().optional(),
  MCP_RUNNER_DEFAULT_IMAGE: z.string().default("node:20-alpine"),
  MCP_RUNNER_IMAGE_MAP_JSON: z.string().optional(),
  MCP_RUNNER_NETWORK_MODE: z.string().default("none"),

  // Optional SMT/formal verifier hook. When enabled, finish_work_branch runs
  // a pre-commit proof over the code-change evidence and verification receipts
  // before committing or pushing.
  FORMAL_VERIFICATION_ENABLED: envBool(false),
  FORMAL_VERIFIER_URL: z.string().default("http://localhost:8010"),
  FORMAL_VERIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  FORMAL_VERIFICATION_BLOCK_ON_UNKNOWN: envBool(true),

  // Context Fabric internal adapter used when the LLM selects a SERVER-target
  // tool. MCP remains the agent loop owner, but governed server tools still
  // execute through Context Fabric + tool-service.
  CONTEXT_FABRIC_URL: z.string().default("http://localhost:8000"),
  CONTEXT_FABRIC_SERVICE_TOKEN: z.string().optional(),

  // Workstream 1: Durable Event Store
  MCP_EVENT_STORE_URL: z.string().optional(),
  MCP_EVENT_STORE_TOKEN: z.string().optional(),
  // M67 Slice 1A — learning-service was folded into agent-service. Default
  // now points at agent-service; the route paths are identical so callers
  // don't have to change anything else.
  LEARNING_SERVICE_URL: z.string().default("http://agent-service:3001"),
  // M61 Wire — Optional agent-runtime URL. When set, /mcp/code-context/build
  // POSTs the workspace's repo fingerprint to
  //   ${AGENT_RUNTIME_URL}/capabilities/:id/world-model/fingerprint
  // (best-effort, fire-and-forget) so the Slice E drift detector can
  // compare against the stored CapabilityWorldModel.repoFingerprint.
  // Empty string disables the report — useful for sandbox tests that
  // don't have an agent-runtime peer.
  AGENT_RUNTIME_URL: z.string().default(""),
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

// ToolInvocationGrant: you cannot turn on grant verification without a key to
// verify with. Refuse to boot in grace/enforce mode if the shared signing
// secret is unset — otherwise every grant check would fail open (in grace) or
// hard-fail every mutating dispatch (in enforce), neither of which is what an
// operator flipping the flag intends. In production the key must also be
// strong, same as every other secret.
if (parsed.data.MCP_TOOL_GRANT_MODE !== "off") {
  if (!parsed.data.TOOL_GRANT_SIGNING_SECRET) {
    console.error(
      `FATAL: MCP_TOOL_GRANT_MODE=${parsed.data.MCP_TOOL_GRANT_MODE} requires ` +
        `TOOL_GRANT_SIGNING_SECRET to be set (it must match context-fabric's value). ` +
        `Set it and restart, or set MCP_TOOL_GRANT_MODE=off.`,
    );
    process.exit(1);
  }
  assertProductionSecretLocal("TOOL_GRANT_SIGNING_SECRET", parsed.data.TOOL_GRANT_SIGNING_SECRET, 32);
}

export const config = {
  ...parsed.data,
  MCP_COMMAND_EXECUTION_MODE: parsed.data.MCP_COMMAND_EXECUTION_MODE
    ?? (parsed.data.NODE_ENV === "test" ? "process" : "container"),
};
