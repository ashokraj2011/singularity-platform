/**
 * M26 — laptop-mode relay client.
 *
 * When LAPTOP_MODE=true, mcp-server skips the inbound HTTP server and instead
 * opens a persistent outbound WebSocket to the platform's laptop-bridge
 * route. Every /mcp/invoke from the platform arrives over the WS, runs the
 * existing executeInvokePayload() locally, and the response goes back over
 * the same socket.
 *
 * Connection lifecycle:
 *   • initial connect → "hello" frame with device_token in Authorization
 *   • on "auth.ack" → start heartbeat (every 30s)
 *   • on "invoke" → run executeInvokePayload, send "response" frame
 *   • on "ping" → bridge keep-alive
 *   • on "disconnect" → close + reconnect with backoff
 *   • on socket close/error → reconnect with exponential backoff (1s→60s, ±25% jitter)
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { log } from "../shared/log";
import { executeInvokePayload } from "../mcp/invoke";
// M75 Slice 2 — laptop bridge handles per-tool tool-run frames in addition
// to the legacy full-loop invoke frame. runToolByName is the same code
// path the platform's HTTP /mcp/tool-run route uses.
import { runToolByName } from "../mcp/tool-run";
// Code-context build over the bridge — the same buildCodeContextPackage the
// platform's HTTP /mcp/code-context/build route calls, run against the laptop's
// LOCAL worktree so the world model reflects the repo that lives here.
import { buildCodeContextPackage, type BuildCodeContextRequest } from "../mcp/code-context";
// Repo source discovery over the bridge — the same GitHub fetch the platform's
// HTTP /mcp/source/tree + /mcp/source/file routes use, run with the laptop's
// LOCAL GITHUB_TOKEN so cloud-side capability bootstrap can discover a repo
// through the user's laptop runtime.
import { fetchGitHubTree, fetchGitHubFile } from "../mcp/source-discover";
import {
  decodeInbound,
  type HelloFrame, type HeartbeatFrame, type ResponseFrame,
} from "./envelopes";

const HEARTBEAT_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface RelayConfig {
  bridgeUrl:    string;                       // wss://platform/api/runtime-bridge/connect
  deviceToken:  string;                       // runtime/device JWT
  deviceId:     string;
  deviceName:   string;
  agentVersion: string;
  runtimeId?:   string;
  runtimeType?: string;
  tenantId?:    string;
  userId?:      string;
  shared?:      boolean;
  runtimeScope?: string;
  capabilityTags?: string[];
}

export class LaptopRelayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private stopping = false;
  private inflight = 0;
  private maxConcurrent = 1;

  constructor(private cfg: RelayConfig) {}

  start(): void {
    this.stopping = false;
    void this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.clearHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000, "client stop"); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;

    log.info({ url: this.cfg.bridgeUrl, device_id: this.cfg.deviceId }, "[laptop-relay] connecting…");

    const ws = new WebSocket(this.cfg.bridgeUrl, {
      headers: { Authorization: `Bearer ${this.cfg.deviceToken}` },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      log.info({}, "[laptop-relay] WS open, sending hello");
      this.sendHello();
    });

    ws.on("message", (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); }
      catch (err) {
        log.warn({ err: (err as Error).message }, "[laptop-relay] bad JSON frame");
        return;
      }
      void this.handleInbound(parsed);
    });

    ws.on("close", (code, reason) => {
      log.warn({ code, reason: reason.toString() }, "[laptop-relay] WS closed");
      this.clearHeartbeat();
      this.ws = null;
      if (!this.stopping) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.warn({ err: err.message }, "[laptop-relay] WS error");
      // 'close' will fire next; reconnect handled there.
    });
  }

  private scheduleReconnect(): void {
    // Exponential backoff with ±25% jitter (R1)
    const jitter = (Math.random() * 0.5 - 0.25) * this.backoffMs;
    const delay  = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, this.backoffMs + jitter));
    log.info({ delayMs: Math.round(delay) }, "[laptop-relay] reconnecting in…");
    setTimeout(() => void this.connect(), delay);
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
  }

  private resetBackoff(): void { this.backoffMs = MIN_BACKOFF_MS; }

  private send(frame: HelloFrame | HeartbeatFrame | ResponseFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(frame)); }
    catch (err) { log.warn({ err: (err as Error).message }, "[laptop-relay] send failed"); }
  }

  private sendHello(): void {
    const hello: HelloFrame = {
      type: "hello",
      device_id:     this.cfg.deviceId,
      runtime_id:    this.cfg.runtimeId ?? this.cfg.deviceId,
      runtime_type:  this.cfg.runtimeType ?? "mcp",
      tenant_id:     this.cfg.tenantId,
      user_id:       this.cfg.userId,
      device_name:   this.cfg.deviceName,
      agent_version: this.cfg.agentVersion,
      capabilities:  [],
      capability_tags: this.cfg.capabilityTags ?? ["mcp", "tools", "llm"],
      shared: this.cfg.shared,
      runtime_scope: this.cfg.runtimeScope,
      health: {
        llm_gateway_url_configured: Boolean(process.env.LLM_GATEWAY_URL),
        llm_gateway_url: redactUrl(process.env.LLM_GATEWAY_URL ?? "http://localhost:8001"),
        git_push_enabled: Boolean(process.env.MCP_GIT_PUSH_ENABLED),
      },
      // M75 Slice 1 — advertise both legacy invoke and the new per-tool
      // tool-run frame. The bridge picks based on which it's configured
      // to send; for the cutover the bridge sends invoke by default and
      // graduates to tool-run as the platform-side dispatch lands
      // (Slice 3). Old bridges that don't know about supported_frame_types
      // just ignore it and keep sending invoke — which still works.
      supported_frame_types: ["invoke", "tool-run", "model-run", "code-context", "source-tree", "source-file"],
    };
    this.send(hello);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", sent_at: new Date().toISOString() });
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleInbound(raw: unknown): Promise<void> {
    const frame = decodeInbound(raw);
    if (!frame) {
      log.warn({}, "[laptop-relay] unrecognised frame");
      return;
    }

    if (frame.type === "auth.ack") {
      log.info({ user_id: frame.user_id, device_id: frame.device_id }, "[laptop-relay] registered with bridge");
      this.resetBackoff();
      this.maxConcurrent = frame.max_concurrent_invokes ?? 1;
      this.startHeartbeat();
      return;
    }

    if (frame.type === "ping") {
      this.send({ type: "heartbeat", sent_at: new Date().toISOString() });
      return;
    }

    if (frame.type === "disconnect") {
      log.warn({ reason: frame.reason }, "[laptop-relay] bridge requested disconnect");
      this.ws?.close(1000, frame.reason);
      return;
    }

    if (frame.type === "invoke") {
      // I5 — serialise concurrent invokes by default.
      if (this.inflight >= this.maxConcurrent) {
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "BUSY", message: `laptop at max ${this.maxConcurrent} concurrent invokes` },
        });
        return;
      }
      this.inflight++;
      try {
        log.info({ request_id: frame.request_id }, "[laptop-relay] running invoke");
        const result = await executeInvokePayload(frame.payload);
        this.send({ type: "response", request_id: frame.request_id, payload: result });
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: unknown };
        log.warn({ err: e.message, request_id: frame.request_id }, "[laptop-relay] invoke failed");
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: {
            code: e.code ?? "INVOKE_FAILED",
            message: e.message ?? "invocation failed",
            details: e.details,
          },
        });
      } finally {
        this.inflight--;
      }
      return;
    }

    // M75 Slice 2 — per-tool dispatch over the bridge. Counted against the
    // SAME inflight gate as invoke for now (decision #2 in the M75 plan:
    // keep serial in Phase A; pipelining is a future optimisation). The
    // handler delegates to runToolByName — the same code path the
    // platform's HTTP /mcp/tool-run route uses, so a tool that works on
    // the platform works identically here.
    if (frame.type === "tool-run") {
      if (this.inflight >= this.maxConcurrent) {
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "BUSY", message: `laptop at max ${this.maxConcurrent} concurrent dispatches` },
        });
        return;
      }
      this.inflight++;
      try {
        log.info(
          { request_id: frame.request_id, tool_name: frame.payload.tool_name },
          "[laptop-relay] running tool-run",
        );
        const outcome = await runToolByName({
          tool_name: frame.payload.tool_name,
          args: frame.payload.args,
          work_item_id: frame.payload.work_item_id,
          workspace_id: frame.payload.workspace_id,
          run_context: frame.payload.run_context as Parameters<typeof runToolByName>[0]["run_context"],
          tool_grant: frame.payload.tool_grant,
        });
        // Response payload shape matches ToolRunResponsePayload in
        // envelopes.ts and the HTTP /tool-run response's `data` field.
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: {
            result: outcome.result,
            duration_ms: outcome.durationMs,
            tool_invocation_id: outcome.toolInvocationId,
            tool_success: outcome.toolSuccess,
            tool_error: outcome.toolError,
          },
        });
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: unknown };
        log.warn(
          { err: e.message, request_id: frame.request_id, tool_name: frame.payload.tool_name },
          "[laptop-relay] tool-run failed",
        );
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: {
            code: e.code ?? "TOOL_RUN_FAILED",
            message: e.message ?? "tool execution failed",
            details: e.details,
          },
        });
      } finally {
        this.inflight--;
      }
      return;
    }

    // LLM dispatch over the bridge (full-BYO-laptop placement; see
    // docs/deployment-topology.md §5). Forward the gateway-shaped chat body to
    // the laptop's LOCAL llm-gateway and return its response. Counted against
    // the same inflight gate as tool-run.
    if (frame.type === "model-run") {
      if (this.inflight >= this.maxConcurrent) {
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "BUSY", message: `laptop at max ${this.maxConcurrent} concurrent dispatches` },
        });
        return;
      }
      this.inflight++;
      try {
        log.info({ request_id: frame.request_id }, "[laptop-relay] running model-run (local LLM)");
        const out = await runModelViaLocalGateway(frame.payload);
        this.send({ type: "response", request_id: frame.request_id, payload: out });
      } catch (err) {
        const e = err as { message?: string };
        log.warn({ err: e.message, request_id: frame.request_id }, "[laptop-relay] model-run failed");
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "MODEL_RUN_FAILED", message: e.message ?? "local LLM call failed" },
        });
      } finally {
        this.inflight--;
      }
      return;
    }

    // Code-context build over the bridge (laptop world model; see
    // docs/deployment-topology.md). Run buildCodeContextPackage against the
    // laptop's LOCAL per-workitem worktree and return the { success, data }
    // envelope — the SAME shape the HTTP /mcp/code-context/build route returns,
    // so context-fabric parses both transports identically. Counted against the
    // same inflight gate as tool-run.
    if (frame.type === "code-context") {
      if (this.inflight >= this.maxConcurrent) {
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "BUSY", message: `laptop at max ${this.maxConcurrent} concurrent dispatches` },
        });
        return;
      }
      this.inflight++;
      try {
        log.info(
          { request_id: frame.request_id },
          "[laptop-relay] running code-context build (local world model)",
        );
        const pkg = await buildCodeContextPackage(
          frame.payload as unknown as BuildCodeContextRequest,
        );
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: { success: true, data: pkg },
        });
      } catch (err) {
        const e = err as { message?: string };
        log.warn(
          { err: e.message, request_id: frame.request_id },
          "[laptop-relay] code-context build failed",
        );
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "CODE_CONTEXT_FAILED", message: e.message ?? "code-context build failed" },
        });
      } finally {
        this.inflight--;
      }
      return;
    }

    // Repo source discovery over the bridge (cloud control plane → laptop). Fetch
    // the repo tree / a file with the laptop's LOCAL GITHUB_TOKEN and return the
    // SAME { tree } / { content } shape mcp's HTTP /mcp/source/* routes return.
    // Same inflight gate as tool-run.
    if (frame.type === "source-tree") {
      if (this.inflight >= this.maxConcurrent) {
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "BUSY", message: `laptop at max ${this.maxConcurrent} concurrent dispatches` },
        });
        return;
      }
      this.inflight++;
      try {
        const { repoUrl, branch } = frame.payload;
        log.info({ request_id: frame.request_id, repoUrl }, "[laptop-relay] running source-tree");
        const tree = await fetchGitHubTree(repoUrl, branch);
        this.send({ type: "response", request_id: frame.request_id, payload: { tree } });
      } catch (err) {
        const e = err as { message?: string };
        log.warn({ err: e.message, request_id: frame.request_id }, "[laptop-relay] source-tree failed");
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "SOURCE_TREE_FAILED", message: e.message ?? "source-tree failed" },
        });
      } finally {
        this.inflight--;
      }
      return;
    }

    if (frame.type === "source-file") {
      if (this.inflight >= this.maxConcurrent) {
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "BUSY", message: `laptop at max ${this.maxConcurrent} concurrent dispatches` },
        });
        return;
      }
      this.inflight++;
      try {
        const { repoUrl, branch, path } = frame.payload;
        log.info({ request_id: frame.request_id, repoUrl, path }, "[laptop-relay] running source-file");
        const content = await fetchGitHubFile(repoUrl, branch, path);
        this.send({ type: "response", request_id: frame.request_id, payload: { content } });
      } catch (err) {
        const e = err as { message?: string };
        log.warn({ err: e.message, request_id: frame.request_id }, "[laptop-relay] source-file failed");
        this.send({
          type: "response",
          request_id: frame.request_id,
          payload: null,
          error: { code: "SOURCE_FILE_FAILED", message: e.message ?? "source-file failed" },
        });
      } finally {
        this.inflight--;
      }
      return;
    }
  }
}

// Forward a gateway-shaped chat-completions body to the laptop's LOCAL
// llm-gateway (LLM_GATEWAY_URL — e.g. a local gateway fronting Copilot/Ollama)
// and return its JSON response unchanged. Lets the cloud governed loop run
// inference on the user's own machine via the model-run frame.
async function runModelViaLocalGateway(body: unknown): Promise<unknown> {
  const base = (process.env.LLM_GATEWAY_URL ?? "http://localhost:8001").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = process.env.LLM_GATEWAY_BEARER;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`local gateway ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Convenience: a stable device_id when none is configured. Real CLI mints
// one and stores it; for env-driven boot we synthesize one per process so
// every boot is recognisable as the same logical "device".
let CACHED_DEVICE_ID: string | null = null;
export function ensureDeviceId(): string {
  if (CACHED_DEVICE_ID) return CACHED_DEVICE_ID;
  CACHED_DEVICE_ID = process.env.SINGULARITY_RUNTIME_ID ?? process.env.SINGULARITY_DEVICE_ID ?? randomUUID();
  return CACHED_DEVICE_ID;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return raw ? "configured" : "";
  }
}
