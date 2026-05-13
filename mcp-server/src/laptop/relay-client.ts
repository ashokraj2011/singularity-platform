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
import {
  decodeInbound,
  type HelloFrame, type HeartbeatFrame, type ResponseFrame,
} from "./envelopes";

const HEARTBEAT_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface RelayConfig {
  bridgeUrl:    string;                       // wss://platform/api/laptop-bridge/connect
  deviceToken:  string;                       // 90-day device JWT
  deviceId:     string;
  deviceName:   string;
  agentVersion: string;
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
      device_name:   this.cfg.deviceName,
      agent_version: this.cfg.agentVersion,
      capabilities:  [],
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
  }
}

// Convenience: a stable device_id when none is configured. Real CLI mints
// one and stores it; for env-driven boot we synthesize one per process so
// every boot is recognisable as the same logical "device".
let CACHED_DEVICE_ID: string | null = null;
export function ensureDeviceId(): string {
  if (CACHED_DEVICE_ID) return CACHED_DEVICE_ID;
  CACHED_DEVICE_ID = process.env.SINGULARITY_DEVICE_ID ?? randomUUID();
  return CACHED_DEVICE_ID;
}
