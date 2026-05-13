/**
 * M26 — wire format between laptop-resident mcp-server and the platform
 * laptop-bridge (context-fabric). Every frame is JSON over WSS.
 *
 * Frames flow in both directions:
 *   ► laptop → bridge    : hello, heartbeat, response, audit
 *   ◄ bridge → laptop    : auth.ack, invoke, ping, disconnect
 *
 * Keep this file dependency-light — it's loaded by both the relay-client
 * and (eventually) the CLI.
 */
import { z } from "zod";

// ── outbound (laptop → bridge) ──────────────────────────────────────────────

export const HelloFrame = z.object({
  type:        z.literal("hello"),
  device_id:   z.string(),
  device_name: z.string(),
  agent_version: z.string(),
  capabilities:  z.array(z.string()).default([]),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

export const HeartbeatFrame = z.object({
  type: z.literal("heartbeat"),
  sent_at: z.string(),
});
export type HeartbeatFrame = z.infer<typeof HeartbeatFrame>;

export const ResponseFrame = z.object({
  type:       z.literal("response"),
  request_id: z.string(),
  payload:    z.unknown(),                    // the executeInvokePayload result
  error:      z.object({
    code:    z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
});
export type ResponseFrame = z.infer<typeof ResponseFrame>;

// ── inbound (bridge → laptop) ───────────────────────────────────────────────

export const AuthAckFrame = z.object({
  type:        z.literal("auth.ack"),
  user_id:     z.string(),
  device_id:   z.string(),
  registered_at: z.string(),
  // Optional payload limits / config the bridge wants the laptop to respect.
  max_concurrent_invokes: z.number().int().positive().optional(),
});
export type AuthAckFrame = z.infer<typeof AuthAckFrame>;

export const InvokeFrame = z.object({
  type:       z.literal("invoke"),
  request_id: z.string(),
  payload:    z.unknown(),                    // raw /mcp/invoke body
  deadline_ms: z.number().int().positive().optional(),
});
export type InvokeFrame = z.infer<typeof InvokeFrame>;

export const PingFrame = z.object({
  type:   z.literal("ping"),
  sent_at: z.string(),
});
export type PingFrame = z.infer<typeof PingFrame>;

export const DisconnectFrame = z.object({
  type:   z.literal("disconnect"),
  reason: z.string(),
});
export type DisconnectFrame = z.infer<typeof DisconnectFrame>;

// ── decoded inbound ─────────────────────────────────────────────────────────

export type InboundFrame = AuthAckFrame | InvokeFrame | PingFrame | DisconnectFrame;

export function decodeInbound(raw: unknown): InboundFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "auth.ack")   return AuthAckFrame.parse(raw);
  if (type === "invoke")     return InvokeFrame.parse(raw);
  if (type === "ping")       return PingFrame.parse(raw);
  if (type === "disconnect") return DisconnectFrame.parse(raw);
  return null;
}
