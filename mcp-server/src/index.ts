import http from "http";
import { WebSocketServer } from "ws";
import { app } from "./app";
import { config } from "./config";
import { log } from "./shared/log";
import { attachWsBridge } from "./mcp/ws";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { LaptopRelayClient, ensureDeviceId } from "./laptop/relay-client";
import { indexWorkspace } from "./workspace/ast-index";
import { configuredDefaultModel, configuredDefaultProvider } from "./llm/provider-config";
// Bug-fix (M-fix) — warm the gateway-provider cache on boot so the first
// Operations Portal page-load after restart shows accurate readiness.
import { refreshGatewayProviderStatus } from "./llm/client";

// Runtime dial-in mode. When LAPTOP_MODE/RUNTIME_DIAL_IN_MODE=true, skip the
// inbound HTTP server and open an outbound WS to Context Fabric's runtime
// bridge. Otherwise boot the standard server with Express + WS for explicit
// debug compatibility.
const LAPTOP_MODE = String(process.env.LAPTOP_MODE ?? "false").toLowerCase() === "true";
const RUNTIME_DIAL_IN_MODE = String(process.env.RUNTIME_DIAL_IN_MODE ?? "false").toLowerCase() === "true";

if (LAPTOP_MODE || RUNTIME_DIAL_IN_MODE) {
  bootLaptopMode();
} else {
  bootServerMode();
}

function bootLaptopMode(): void {
  warmAstIndex();
  const bridgeUrl   = process.env.RUNTIME_BRIDGE_URL
    ?? process.env.LAPTOP_BRIDGE_URL
    ?? "ws://localhost:8000/api/runtime-bridge/connect";
  const deviceToken = process.env.SINGULARITY_RUNTIME_TOKEN ?? process.env.SINGULARITY_DEVICE_TOKEN;
  if (!deviceToken) {
    log.error({}, "[runtime-dial-in] SINGULARITY_RUNTIME_TOKEN/SINGULARITY_DEVICE_TOKEN unset — mint a runtime token and set the env. Exiting.");
    process.exit(1);
  }
  const deviceName = process.env.SINGULARITY_RUNTIME_NAME
    ?? process.env.SINGULARITY_DEVICE_NAME
    ?? `mcp-runtime-${process.platform}`;
  const client = new LaptopRelayClient({
    bridgeUrl,
    deviceToken,
    deviceId:     ensureDeviceId(),
    deviceName,
    agentVersion: "0.1.0",
    runtimeId:    process.env.SINGULARITY_RUNTIME_ID ?? ensureDeviceId(),
    runtimeType:  process.env.SINGULARITY_RUNTIME_TYPE ?? "mcp",
    tenantId:     process.env.SINGULARITY_TENANT_ID,
    userId:       process.env.SINGULARITY_USER_ID,
    shared:       String(process.env.SINGULARITY_RUNTIME_SHARED ?? "false").toLowerCase() === "true",
    runtimeScope: process.env.SINGULARITY_RUNTIME_SCOPE,
    capabilityTags: (process.env.SINGULARITY_RUNTIME_CAPABILITY_TAGS ?? "mcp,tools,llm")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  client.start();
  log.info({ bridgeUrl, runtimeId: ensureDeviceId(), deviceName }, "[runtime-dial-in] relay client started");
  // M101 — redacted git-auth boot diagnostic (laptop runs the loop locally and
  // may push). Token value never logged — only source/length/class.
  log.info(gitAuthDiagnostic(), "[runtime-dial-in] git-auth (redacted — token value never logged)");

  // Keep node alive (the relay-client uses internal timers + WS, but if the
  // WS fails permanently and backoff exits, we still want the process to
  // stay up so ops can inspect / restart).
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);
  const shutdown = () => { client.stop(); clearInterval(keepAlive); process.exit(0); };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * M101 — redacted git-auth diagnostic. Mirrors the token resolution order in
 * git-workspace.ts:340 (process.env[MCP_GIT_TOKEN_ENV] → MCP_GIT_TOKEN →
 * GITHUB_TOKEN → GH_TOKEN) and reports WHICH source resolved, plus the token's
 * length and class prefix — NEVER its value. The class prefix (e.g.
 * "github_pat", "ghp") is the documented, non-secret token-type label.
 */
function gitAuthDiagnostic(): Record<string, unknown> {
  const tokenEnvName = config.MCP_GIT_TOKEN_ENV || "GITHUB_TOKEN";
  let token: string | undefined;
  let source = "(none)";
  if (process.env[tokenEnvName]) { token = process.env[tokenEnvName]; source = tokenEnvName; }
  else if (config.MCP_GIT_TOKEN)  { token = config.MCP_GIT_TOKEN;  source = "MCP_GIT_TOKEN"; }
  else if (process.env.GITHUB_TOKEN) { token = process.env.GITHUB_TOKEN; source = "GITHUB_TOKEN"; }
  else if (process.env.GH_TOKEN)  { token = process.env.GH_TOKEN;  source = "GH_TOKEN"; }

  let tokenClass = "none";
  if (token) {
    const m = token.match(/^(github_pat|ghp|gho|ghu|ghs|ghr)_/);
    tokenClass = m ? m[1] : "opaque";
  }
  return {
    authMode: config.MCP_GIT_AUTH_MODE,
    pushEnabled: config.MCP_GIT_PUSH_ENABLED,
    tokenEnv: tokenEnvName,
    tokenSource: source,
    tokenPresent: Boolean(token),
    tokenLen: token ? token.length : 0,
    tokenClass,
    pushRemote: config.MCP_GIT_PUSH_REMOTE,
    username: config.MCP_GIT_USERNAME,
  };
}

function bootServerMode(): void {
  warmAstIndex();
  const server = http.createServer(app);

  // WebSocket bridge (PLAN_mcp.md §4) on the SAME http server, path-mounted at
  // /mcp/ws. Co-locating with the HTTP routes keeps a single port + a single
  // auth surface (the same MCP_BEARER_TOKEN, presented via Authorization or
  // the Sec-WebSocket-Protocol subprotocol).
  const wss = new WebSocketServer({ server, path: "/mcp/ws" });
  attachWsBridge(wss);

  // M11.a — self-register with platform-registry (no-op if env unset)
  startSelfRegistration({
    service_name: "mcp-server",
    display_name: "Singularity Tool Runtime",
    version:      "0.1.0",
    base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`,
    health_path:  "/healthz",
    auth_mode:    "bearer-static",
    owner_team:   "platform",
    metadata:     { layer: "execution", provider: configuredDefaultProvider(), ws_path: "/mcp/ws" },
    capabilities: [
      { capability_key: "mcp.tools.list",    description: "MCP tools/list" },
      { capability_key: "mcp.tools.call",    description: "MCP tools/call (server-side or local)" },
      { capability_key: "mcp.discovery",     description: "Standard MCP discovery document" },
      { capability_key: "mcp.invoke",        description: "Drive an LLM<->tool agent loop" },
      { capability_key: "mcp.resume",        description: "Resume a paused agent loop after approval" },
      { capability_key: "mcp.events.ws",     description: "Live event subscription via WebSocket bridge" },
    ],
  }, { log: (m) => log.info({}, `[platform-registry] ${m}`) });

  server.listen(config.PORT, () => {
    log.info(
      {
        port: config.PORT,
        provider: configuredDefaultProvider(),
        model: configuredDefaultModel(),
        maxSteps: config.MAX_AGENT_STEPS,
        ws_path: "/mcp/ws",
      },
      "[mcp-server] listening",
    );
    // M101 — redacted git-auth boot diagnostic. On any host, this one line
    // tells you which token actually resolved (source env var, length, class)
    // and whether push is enabled — without ever logging the token value.
    log.info(gitAuthDiagnostic(), "[mcp-server] git-auth (redacted — token value never logged)");
    // Bug-fix (M-fix) — fire-and-forget cache warm. Without this, the
    // first /llm/models call after boot would synchronously probe the
    // gateway (adding 100-2000ms latency). With this, the cache is warm
    // by the time the Portal renders the readiness panel.
    void refreshGatewayProviderStatus().catch((err) => {
      log.warn({ err: (err as Error).message }, "[mcp-server] initial gateway probe failed (cache will refresh lazily on first /llm/* request)");
    });
  });
}

function warmAstIndex(): void {
  setTimeout(() => {
    void indexWorkspace("startup").then((stats) => {
      log.info({
        status: stats.status,
        files: stats.indexedFiles,
        symbols: stats.indexedSymbols,
        dbPath: stats.dbPath,
        error: stats.error,
      }, "[mcp-server] local AST index warmup complete");
    });
  }, 2_000);
}
