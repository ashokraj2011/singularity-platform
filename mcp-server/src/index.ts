import http from "http";
import { WebSocketServer } from "ws";
import { app } from "./app";
import { config } from "./config";
import { log } from "./shared/log";
import { attachWsBridge } from "./mcp/ws";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { LaptopRelayClient, ensureDeviceId } from "./laptop/relay-client";

// M26 — laptop mode. When LAPTOP_MODE=true, skip the inbound HTTP server
// (laptops can't open ports behind NAT) and open an outbound WSS to the
// platform bridge. Otherwise boot the standard server with Express + WS.
const LAPTOP_MODE = String(process.env.LAPTOP_MODE ?? "false").toLowerCase() === "true";

if (LAPTOP_MODE) {
  bootLaptopMode();
} else {
  bootServerMode();
}

function bootLaptopMode(): void {
  const bridgeUrl   = process.env.LAPTOP_BRIDGE_URL ?? "ws://localhost:8000/api/laptop-bridge/connect";
  const deviceToken = process.env.SINGULARITY_DEVICE_TOKEN;
  if (!deviceToken) {
    log.error({}, "[laptop-mode] SINGULARITY_DEVICE_TOKEN unset — run `singularity-mcp login` first or set the env. Exiting.");
    process.exit(1);
  }
  const deviceName = process.env.SINGULARITY_DEVICE_NAME ?? `mcp-laptop-${process.platform}`;
  const client = new LaptopRelayClient({
    bridgeUrl,
    deviceToken,
    deviceId:     ensureDeviceId(),
    deviceName,
    agentVersion: "0.1.0",
  });
  client.start();
  log.info({ bridgeUrl, deviceId: ensureDeviceId(), deviceName }, "[laptop-mode] relay client started");

  // Keep node alive (the relay-client uses internal timers + WS, but if the
  // WS fails permanently and backoff exits, we still want the process to
  // stay up so ops can inspect / restart).
  const keepAlive = setInterval(() => { /* tick */ }, 60_000);
  const shutdown = () => { client.stop(); clearInterval(keepAlive); process.exit(0); };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
}

function bootServerMode(): void {
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
    display_name: "Singularity MCP Server",
    version:      "0.1.0",
    base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`,
    health_path:  "/healthz",
    auth_mode:    "bearer-static",
    owner_team:   "platform",
    metadata:     { layer: "execution", provider: config.LLM_PROVIDER, ws_path: "/mcp/ws" },
    capabilities: [
      { capability_key: "mcp.tools.list",    description: "MCP tools/list" },
      { capability_key: "mcp.tools.call",    description: "MCP tools/call (server-side or local)" },
      { capability_key: "mcp.invoke",        description: "Drive an LLM<->tool agent loop" },
      { capability_key: "mcp.resume",        description: "Resume a paused agent loop after approval" },
      { capability_key: "mcp.events.ws",     description: "Live event subscription via WebSocket bridge" },
    ],
  }, { log: (m) => log.info({}, `[platform-registry] ${m}`) });

  server.listen(config.PORT, () => {
    log.info(
      {
        port: config.PORT,
        provider: config.LLM_PROVIDER,
        model: config.LLM_MODEL,
        maxSteps: config.MAX_AGENT_STEPS,
        ws_path: "/mcp/ws",
      },
      "[mcp-server] listening",
    );
  });
}
