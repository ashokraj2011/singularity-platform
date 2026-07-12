import { config as dotenvConfig } from 'dotenv'
import { z } from 'zod'

dotenvConfig()

function envBool(defaultValue: boolean) {
  return z.string().optional().transform((raw) => {
    if (raw === undefined || raw === null) return defaultValue
    const normalized = String(raw).trim().toLowerCase()
    if (normalized === '') return defaultValue
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
    return defaultValue
  })
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string(),
  // RLS prep — the owner/admin DB connection (bootstrap-app-role.sh creates it
  // specifically "for Prisma migrations and RLS cutovers"). The app's normal
  // DATABASE_URL connects as workgraph_app (NOSUPERUSER NOBYPASSRLS — genuinely
  // RLS-bound), so it can't see across tenants. Optional: only needed for
  // TimerSweep's cross-tenant discovery sweep (lib/admin-prisma.ts); most
  // dev/test setups won't set it and the sweep falls back to the regular
  // tenant-scoped client (today's exact behavior).
  WORKGRAPH_DATABASE_URL_ADMIN: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: envBool(false),
  MINIO_ACCESS_KEY: z.string().default('workgraph'),
  MINIO_SECRET_KEY: z.string().default('workgraph_secret'),
  MINIO_BUCKET: z.string().default('workgraph-documents'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),

  // ── Identity provider (Singularity IAM federation) ─────────────────────────
  // 'iam'   → all auth + authz delegated to IAM (production)
  // 'local' → fall back to the built-in HS256 JWT + bcrypt login (offline dev)
  AUTH_PROVIDER: z.enum(['iam', 'local']).default('iam'),
  // Human approval policy keys.  The values are permission names, not role
  // names; local deployments resolve them from the permissions/role tables and
  // IAM deployments resolve them through /authz/check.  Operators can remap a
  // surface without changing application code.
  APPROVAL_WORKFLOW_PERMISSION: z.string().min(1).default('workflow:approve'),
  APPROVAL_AGENT_PERMISSION: z.string().min(1).default('agent:approve'),
  APPROVAL_TOOL_PERMISSION: z.string().min(1).default('tool:approve_execution'),
  APPROVAL_GOVERNANCE_PERMISSION: z.string().min(1).default('governance:approve'),
  APPROVAL_CONSUMABLE_PERMISSION: z.string().min(1).default('consumable:approve'),
  PLATFORM_ADMIN_PERMISSION: z.string().min(1).default('platform:all'),
  // Base URL for the IAM HTTP API (e.g. http://localhost:8100/api/v1).
  IAM_BASE_URL: z.string().optional(),
  // Long-lived bearer used by workgraph-studio when calling IAM as a service
  // (e.g. for member lookups, skill resolution).  Required if AUTH_PROVIDER=iam.
  IAM_SERVICE_TOKEN: z.string().optional(),
  // Comma-separated tenant ids this service token may operate on. Required
  // for strict tenant-isolated service-to-service calls.
  IAM_SERVICE_TOKEN_TENANT_IDS: z.string().default(''),
  // TTL (seconds) for the in-memory token-verification cache.
  IAM_VERIFY_CACHE_TTL: z.coerce.number().default(60),

  // ── Prompt Composer (M5 — kept for backwards compat; M8 routes through context-fabric) ──
  PROMPT_COMPOSER_URL: z.string().default('http://localhost:3004'),

  // ── Context Fabric (M8 — AGENT_TASK executor calls /execute) ──
  CONTEXT_FABRIC_URL: z.string().default('http://localhost:8000'),
  DEFAULT_GOVERNANCE_MODE: z.enum(['fail_open', 'fail_closed', 'degraded', 'human_approval_required']).default('fail_open'),
  // M13 — service token for context-fabric's /internal/mcp/* surface (the
  // proxy that resolves code-changes through MCP). Should match the value
  // configured on context-fabric as IAM_SERVICE_TOKEN. In dev with no IAM
  // (pseudo-iam mode) this can be any matching string.
  CONTEXT_FABRIC_SERVICE_TOKEN: z.string().optional(),

  // ── M10 — agent-and-tools upstream URLs for federated lookups ──
  AGENT_SERVICE_URL: z.string().default('http://localhost:3001'),
  TOOL_SERVICE_URL:  z.string().default('http://localhost:3001'),
  AGENT_RUNTIME_URL: z.string().default('http://localhost:3003'),
  // Snapshot-time token used by the workflow runtime when no user context is
  // available (AgentTaskExecutor writing the agent snapshot row). User-facing
  // /api/lookup/* calls forward the caller's JWT instead.
  WORKGRAPH_SNAPSHOT_TOKEN: z.string().optional(),

  // M24 — audit-governance ledger (port 8500). Used by the run insights
  // dashboard to splice cost/token/governance rollups into the per-run view.
  AUDIT_GOV_URL: z.string().default('http://host.docker.internal:8500'),

  // MCP owns local execution; the central LLM gateway owns provider/model
  // routing. Workflow execution passes model aliases through Context Fabric.
  MCP_SERVER_URL: z.string().default('http://localhost:7100'),
  MCP_BEARER_TOKEN: z.string().default('demo-bearer-token-must-be-min-16-chars'),
  MCP_TOOL_GRANT_MODE: z.enum(['off', 'grace', 'enforce']).default('off'),
  WORKGRAPH_INTERNAL_TOKEN: z.string().default('dev-workgraph-internal-token'),
  WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS: z.string().default(''),
  WORKGRAPH_INCOMING_EVENT_SECRETS: z.string().default(''),
  LAPTOP_HEARTBEAT_TIMEOUT_SEC: z.coerce.number().int().positive().default(300),
  LAPTOP_HEARTBEAT_SWEEP_SEC: z.coerce.number().int().positive().default(60),
  LAPTOP_MCP_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(12 * 60 * 60),
  TENANT_ISOLATION_MODE: z.enum(['off', 'strict']).default('off'),
  // Fallback tenant stamped on rows created without an explicit tenant (trigger-
  // spawned runs, seeds, unscoped creates) so no row is left tenantId=NULL under
  // forced RLS. In a single-tenant deployment every row collapses to this value.
  // MUST match the backfill migration + the app role's `SET app.tenant_id`
  // default; if you change it, re-backfill and re-run bootstrap-app-role.sh.
  WORKGRAPH_DEFAULT_TENANT_ID: z.string().min(1).default('default'),
  // Stuck-run watchdog (durable-execution hardening). A SERVER node whose in-process
  // execution died leaves the node ACTIVE forever (no timer / pending row / signal
  // wait to recover it). The watchdog recovers ACTIVE non-wait nodes untouched past
  // this age (default 30 min): failNode() retries them if retryPolicy attempts remain,
  // else FAILs so the run surfaces loudly instead of hanging.
  WORKFLOW_STUCK_NODE_THRESHOLD_MS: z.coerce.number().int().positive().default(1_800_000),
  WORKFLOW_STUCK_WATCHDOG_ENABLED: z.enum(['true', 'false']).default('true'),
  EVENT_HORIZON_MODEL_ALIAS: z.string().optional(),

  // One-shot LLM calls route through Context Fabric's governed single-turn API.
  // LLM_GATEWAY_URL and LLM_GATEWAY_BEARER are retired; this timeout remains
  // the compatibility knob for those legacy one-shot callers.
  LLM_GATEWAY_TIMEOUT_SEC: z.coerce.number().int().positive().default(240),

  // Optional SMT governance path analyzer. Default off; disabled callers must
  // skip/return clear evidence and never call the verifier service.
  FORMAL_VERIFICATION_ENABLED: envBool(false),
  FORMAL_VERIFIER_URL: z.string().default('http://localhost:8010'),

  // M78 Slice 4 — Auto-remediation pipeline. When ON, the develop-stage
  // approval gate stops throwing a blocking error for inherited-only
  // failures and instead spawns one remediation WorkItem per inherited
  // failure, returning the list to the workbench so the operator sees
  // "🤖 auto-spawned WI-1234, WI-1235" instead of "fix these manually".
  // The original WI's gate stays blocked (no auto-unblock yet — operator
  // re-tries approval once the remediation WIs land). Off by default;
  // operator opts in at the platform level by setting this in compose.
  WORKGRAPH_AUTO_REMEDIATE_INHERITED_FAILURES: envBool(false),

  // Task #119 — compatibility flag for the non-blueprint governed migration.
  // When true, the workflow AGENT_TASK executor routes through context-
  // fabric's /api/v1/execute-governed-stage (the M71 phase-based path
  // already used by blueprint flows) instead of the legacy /api/v1/
  // execute endpoint. Kept for older deployments; the normal default is
  // WORKGRAPH_FORCE_GOVERNED_CODING=true below.
  CONTEXT_FABRIC_USE_GOVERNED_FOR_NON_BLUEPRINT: envBool(false),

  // M99 S3.1 — Phase-3 default flip for "Centralize Agentic Coding Around
  // Context Fabric". NON-blueprint AGENT_TASK coding nodes now default to the
  // governed path even without a per-node useGovernedExecutor toggle. The
  // legacy /execute path is reachable only by explicit per-node opt-out
  // (useGovernedExecutor === false) or by setting this env var to false for
  // incident recovery.
  WORKGRAPH_FORCE_GOVERNED_CODING: envBool(true),

  // Route single-shot side callers that already hold a complete prompt through
  // Context Fabric's governed single-turn endpoint. Event Horizon chat is the
  // current user-facing side caller; set false only for incident recovery.
  CONTEXT_FABRIC_GOVERN_SIDE_CALLERS: envBool(true),
})

// M35.1 — production-class envs refuse to start with weak secrets.
// Mirrors the @agentandtools/shared assertProductionSecret helper.
// Inlined here because workgraph-api lives outside the agent-and-tools
// workspace and can't import that package.
const PROD_ENVS = new Set(['production', 'prod', 'staging', 'perf'])

function productionClassEnv(): string | null {
  for (const env of [
    process.env.NODE_ENV,
    process.env.APP_ENV,
    process.env.ENVIRONMENT,
    process.env.SINGULARITY_ENV,
  ]) {
    const normalized = (env ?? '').toLowerCase()
    if (PROD_ENVS.has(normalized)) return normalized
  }
  return null
}

function assertProductionSecretLocal(name: string, value: string | undefined, minLength = 32): void {
  const env = productionClassEnv()
  if (!env) return
  const KNOWN_BAD = new Set([
    'dev-secret-change-in-prod',
    'dev-secret-change-in-prod-min-32-chars!!',
    'changeme_dev_only_min_32_chars_long!!',
    'demo-bearer-token-must-be-min-16-chars',
    'dev-audit-gov-service-token',
    'changeme',
    'test-secret',
  ])
  const v = value ?? ''
  const reasons: string[] = []
  if (v.length === 0) reasons.push('unset')
  else if (v.length < minLength) reasons.push(`shorter than ${minLength} chars (got ${v.length})`)
  if (KNOWN_BAD.has(v)) reasons.push('matches a known development default')
  if (reasons.length > 0) {
    console.error(`FATAL: ${name} is unsafe for production-class environment (${env}): ${reasons.join('; ')}. Set ${name} to a strong random value (${minLength}+ chars) and restart.`)
    process.exit(1)
  }
}

function assertProductionInvariantLocal(name: string, ok: boolean, message: string): void {
  const env = productionClassEnv()
  if (!env || ok) return
  console.error(`FATAL: ${name} is unsafe for production-class environment (${env}): ${message}`)
  process.exit(1)
}

function parseIncomingEventSecrets(raw: string): Record<string, string> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([source, secret]) => source.trim().length > 0 && typeof secret === 'string' && secret.trim().length > 0)
        .map(([source, secret]) => [source, (secret as string).trim()]),
    )
  } catch {
    return {}
  }
}

function hasOnlyStrongIncomingEventSecrets(raw: string): boolean {
  const secrets = parseIncomingEventSecrets(raw)
  const values = Object.values(secrets)
  return values.length > 0 && values.every((value) => value.length >= 32 && !value.startsWith('dev-') && !value.startsWith('test-') && value !== 'changeme')
}

function loadConfig() {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors)
    process.exit(1)
  }
  assertProductionSecretLocal('JWT_SECRET', result.data.JWT_SECRET)
  assertProductionSecretLocal('MCP_BEARER_TOKEN', result.data.MCP_BEARER_TOKEN)
  assertProductionSecretLocal('WORKGRAPH_INTERNAL_TOKEN', result.data.WORKGRAPH_INTERNAL_TOKEN)
  assertProductionSecretLocal('CONTEXT_FABRIC_SERVICE_TOKEN', result.data.CONTEXT_FABRIC_SERVICE_TOKEN)
  assertProductionInvariantLocal(
    'WORKGRAPH_INCOMING_EVENT_SECRETS',
    hasOnlyStrongIncomingEventSecrets(result.data.WORKGRAPH_INCOMING_EVENT_SECRETS),
    'set WORKGRAPH_INCOMING_EVENT_SECRETS to a non-empty JSON object of source_service -> 32+ character HMAC secrets',
  )
  assertProductionInvariantLocal(
    'AUTH_PROVIDER',
    result.data.AUTH_PROVIDER === 'iam',
    'set AUTH_PROVIDER=iam; local auth is development-only',
  )
  assertProductionInvariantLocal(
    'TENANT_ISOLATION_MODE',
    result.data.TENANT_ISOLATION_MODE === 'strict',
    'set TENANT_ISOLATION_MODE=strict for production-class deployments',
  )
  assertProductionInvariantLocal(
    'DEFAULT_GOVERNANCE_MODE',
    result.data.DEFAULT_GOVERNANCE_MODE === 'fail_closed',
    'set DEFAULT_GOVERNANCE_MODE=fail_closed so workflow defaults cannot override Context Fabric fail-closed governance',
  )
  assertProductionInvariantLocal(
    'IAM_SERVICE_TOKEN',
    Boolean(result.data.IAM_SERVICE_TOKEN)
      || (Boolean(process.env.IAM_BOOTSTRAP_USERNAME) && Boolean(process.env.IAM_BOOTSTRAP_PASSWORD)),
    'set IAM_SERVICE_TOKEN or IAM_BOOTSTRAP_USERNAME/IAM_BOOTSTRAP_PASSWORD so Workgraph can authenticate service-to-service calls to Prompt Composer, agent-and-tools, and IAM',
  )
  return result.data
}

export const config = loadConfig()
