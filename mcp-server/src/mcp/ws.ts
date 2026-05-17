/**
 * WebSocket bridge — PLAN_mcp.md §4.
 *
 * One bidirectional connection per subscriber, multiplexes:
 *   - subscribe.events    {filters}                 → ack + stream
 *   - unsubscribe.events  {subscription_id}         → ack
 *   - replay.events       {since_id|since_timestamp,
 *                          filters, limit}          → ack + replay batch + stream catches up
 *   - ping                                          → pong
 *
 * Wire envelope (every direction):
 *   { type: "subscribe.events" | ..., id?: <correlation>, ... }
 *
 * Auth: handshake requires `Sec-WebSocket-Protocol: bearer.<TOKEN>` OR
 *       `Authorization: Bearer <TOKEN>` header (browsers only support the
 *       former, programmatic clients support both).
 *
 * v0 only — durable distribution is M9.x platform work.
 */
import { IncomingMessage } from "http";
import { v4 as uuidv4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "../config";
import { log } from "../shared/log";
import { events } from "../events/bus";
import { McpEventEnvelope, SubscriptionFilter } from "../events/types";

interface ActiveSubscription {
  id: string;
  unsubscribe: () => void;
  // M35.2 — Per-subscription event queue with backpressure
  eventQueue: McpEventEnvelope[];
}

function authorise(req: IncomingMessage): boolean {
  const headerAuth = req.headers["authorization"];
  if (typeof headerAuth === "string" && headerAuth.startsWith("Bearer ")) {
    return headerAuth.slice(7) === config.MCP_BEARER_TOKEN;
  }
  // Browser/JS clients can't set Authorization on a WS handshake; they pass
  // the bearer in Sec-WebSocket-Protocol as `bearer.<token>` (a common
  // subprotocol convention).
  const protoHeader = req.headers["sec-websocket-protocol"];
  if (typeof protoHeader === "string") {
    const protos = protoHeader.split(",").map((p) => p.trim());
    for (const p of protos) {
      if (p.startsWith("bearer.")) return p.slice(7) === config.MCP_BEARER_TOKEN;
    }
  }
  return false;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function attachWsBridge(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (!authorise(req)) {
      send(ws, { type: "error", error: "unauthorized" });
      ws.close(4401, "unauthorized");
      return;
    }
    const subs = new Map<string, ActiveSubscription>();
    log.debug({ remote: req.socket.remoteAddress }, "ws connected");

    send(ws, { type: "hello", server: "singularity-mcp-server", protocol: "mcp.ws.v0" });

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        send(ws, { type: "error", error: "invalid_json" });
        return;
      }
      const type = msg.type as string | undefined;
      const correlationId = (msg.id as string | undefined) ?? uuidv4();

      if (type === "ping") {
        send(ws, { type: "pong", id: correlationId });
        return;
      }

      if (type === "subscribe.events") {
        const filter = (msg.filter ?? msg.filters) as SubscriptionFilter | undefined;
        const subId = uuidv4();
        const sub: ActiveSubscription = {
          id: subId,
          unsubscribe: () => {},
          eventQueue: [],
        };
        // M35.2 — Subscription with queue cap 1000, warn at 75%, drop oldest at cap
        const off = events.subscribe(filter, (ev: McpEventEnvelope) => {
          const QUEUE_CAP = 1000;
          const WARN_THRESHOLD = 750; // 75%

          sub.eventQueue.push(ev);
          if (sub.eventQueue.length === WARN_THRESHOLD) {
            send(ws, {
              type: "backpressure.warning",
              subscription_id: subId,
              queue_size: sub.eventQueue.length,
              message: "event queue approaching capacity",
            });
          }
          if (sub.eventQueue.length > QUEUE_CAP) {
            // Drop the oldest event
            sub.eventQueue.shift();
          }
          // Send the event to the client
          send(ws, { type: "event", subscription_id: subId, event: ev });
        });
        sub.unsubscribe = off;
        subs.set(subId, sub);
        send(ws, { type: "subscribed", id: correlationId, subscription_id: subId });
        return;
      }

      if (type === "unsubscribe.events") {
        const subId = msg.subscription_id as string | undefined;
        if (subId && subs.has(subId)) {
          subs.get(subId)!.unsubscribe();
          subs.delete(subId);
          send(ws, { type: "unsubscribed", id: correlationId, subscription_id: subId });
        } else {
          send(ws, { type: "error", id: correlationId, error: "subscription_not_found" });
        }
        return;
      }

      if (type === "replay.events") {
        const filter = (msg.filter ?? msg.filters) as SubscriptionFilter | undefined;
        const since_id = msg.since_id as string | undefined;
        const since_timestamp = msg.since_timestamp as string | undefined;
        // M35.2 — Cap replay to 5000 events or 10 MB, whichever first
        const MAX_REPLAY_EVENTS = 5000;
        const MAX_REPLAY_BYTES = 10 * 1024 * 1024; // 10 MB
        const limit = (msg.limit as number | undefined) ?? 500;
        const requestLimit = Math.min(limit, MAX_REPLAY_EVENTS);
        const batch = events.replaySince({ since_id, since_timestamp, filter, limit: requestLimit });

        // Calculate total size of batch and truncate if needed
        let totalBytes = 0;
        let truncatedBatch = batch;
        for (let i = 0; i < batch.length; i++) {
          const eventSize = JSON.stringify(batch[i]).length;
          if (totalBytes + eventSize > MAX_REPLAY_BYTES) {
            truncatedBatch = batch.slice(0, i);
            break;
          }
          totalBytes += eventSize;
        }

        send(ws, {
          type: "replay.batch",
          id: correlationId,
          count: truncatedBatch.length,
          events: truncatedBatch,
          // tail_id helps the client request the next replay window
          tail_id: truncatedBatch.length > 0 ? truncatedBatch[truncatedBatch.length - 1].id : null,
          // M35.2 — Signal if the replay was truncated due to limits
          replay_truncated: truncatedBatch.length < batch.length,
        });
        return;
      }

      send(ws, { type: "error", id: correlationId, error: `unknown_type:${type ?? "<missing>"}` });
    });

    ws.on("close", () => {
      for (const sub of subs.values()) sub.unsubscribe();
      subs.clear();
      log.debug({ remote: req.socket.remoteAddress }, "ws disconnected");
    });
  });
}
