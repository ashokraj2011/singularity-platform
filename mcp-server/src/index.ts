import http from "http";
import { WebSocketServer } from "ws";
import { app } from "./app";
import { config } from "./config";
import { log } from "./shared/log";
import { attachWsBridge } from "./mcp/ws";
import { startSelfRegistration } from "./lib/platform-registry/register";

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
