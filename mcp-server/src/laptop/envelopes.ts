/**
 * M26 — wire format between laptop-resident mcp-server and the platform
 * laptop-bridge (context-fabric). Every frame is JSON over WSS.
 *
 * Frames flow in both directions:
 *   ► laptop → bridge    : hello, heartbeat, response, audit
 *   ◄ bridge → laptop    : auth.ack, invoke, tool-run, ping, disconnect
 *
 * Keep this file dependency-light — it's loaded by both the relay-client
 * and (eventually) the CLI.
 *
 * M75 Slice 1 — added `tool-run` frame as the per-tool-call alternative
 * to the legacy `invoke` frame (which carried the full agent loop
 * payload). The new frame mirrors the HTTP /mcp/tool-run body 1:1, so
 * the laptop's handler runs the same code as the platform-side route.
 *
 * Capability negotiation:
 *   - new laptops send hello.supported_frame_types=["invoke","tool-run"].
 *     Bridge then sends tool-run frames for governed-loop stages.
 *   - old laptops omit the field; it defaults to ["invoke"] and the
 *     bridge falls back to the legacy invoke path.
 *   - new bridge talking to old laptop reads the missing field as
 *     legacy-only and sends invoke frames.
 *   - old bridge talking to new laptop ignores the new field and
 *     sends invoke frames; the new laptop still handles them.
 *
 * Both directions degrade safely without coordination — no protocol
 * version handshake needed beyond the field default.
 */
import { z } from "zod";

// ── outbound (laptop → bridge) ──────────────────────────────────────────────

// M75 Slice 1 — wire-format frame-type identifiers the laptop understands.
// Bridge inspects hello.supported_frame_types to choose between sending
// legacy "invoke" frames and new "tool-run" frames. Old laptops omit
// the field; .default(["invoke"]) maintains backward compat.
export const SUPPORTED_FRAME_TYPES = ["invoke", "tool-run", "model-run", "code-context"] as const;
export type SupportedFrameType = (typeof SUPPORTED_FRAME_TYPES)[number];

export const HelloFrame = z.object({
  type:        z.literal("hello"),
  device_id:   z.string(),
  device_name: z.string(),
  agent_version: z.string(),
  capabilities:  z.array(z.string()).default([]),
  // M75 Slice 1 — which bridge → laptop frame types this binary can
  // handle. Defaults to legacy-only so pre-M75 laptops that don't
  // emit the field still get correctly classified.
  supported_frame_types: z.array(z.enum(SUPPORTED_FRAME_TYPES)).default(["invoke"]),
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

// M75 Slice 1 — per-tool-call frame, the governed-loop alternative to
// the legacy `invoke` frame. Payload mirrors the HTTP /mcp/tool-run
// body 1:1 so the laptop handler runs the same code as the platform
// /mcp/tool-run route.
//
// The wider context: under M71 + M74, context-fabric drives the agent
// loop and dispatches one tool at a time. For platform mcp-servers
// that lands as a /mcp/tool-run HTTP POST. For laptop mcp-servers it
// arrives as this WebSocket frame. The bridge picks based on the
// hello.supported_frame_types capability bits.
export const ToolRunPayload = z.object({
  tool_name:    z.string(),
  args:         z.record(z.unknown()).default({}),
  // Either work_item_id OR workspace_id should be set so the laptop
  // routes the tool to the right sandbox. mcp-server treats them as
  // aliases on the dispatch path.
  work_item_id: z.string().optional(),
  workspace_id: z.string().optional(),
  // Correlation IDs (traceId, runId, workflowInstanceId, nodeId,
  // branchName, capabilityId, attemptId, …). Flows into the audit
  // invocation record so a laptop-side tool call is joinable to the
  // governed_step that issued it.
  run_context:  z.record(z.unknown()).default({}),
});
export type ToolRunPayload = z.infer<typeof ToolRunPayload>;

export const ToolRunFrame = z.object({
  type:       z.literal("tool-run"),
  request_id: z.string(),
  payload:    ToolRunPayload,
  deadline_ms: z.number().int().positive().optional(),
});
export type ToolRunFrame = z.infer<typeof ToolRunFrame>;

// Typed response payload for a tool-run request. The wire-level
// ResponseFrame (below) carries this as its opaque `payload` field —
// callers that issued a tool-run frame validate the response payload
// against this schema before treating the fields as known.
//
// Shape matches mcp-server's HTTP /mcp/tool-run response so the
// dispatcher on the context-fabric side can normalise both transports
// to the same ToolDispatchResult dataclass.
export const ToolRunResponsePayload = z.object({
  result:             z.unknown(),
  duration_ms:        z.number().int().nonnegative(),
  tool_invocation_id: z.string(),
  tool_success:       z.boolean(),
  tool_error:         z.string().nullable().optional(),
});
export type ToolRunResponsePayload = z.infer<typeof ToolRunResponsePayload>;

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

// LLM dispatch over the bridge (full-BYO-laptop placement; see
// docs/deployment-topology.md §5). The payload is the llm-gateway
// /v1/chat/completions REQUEST body (messages, tools, model_alias, …) built by
// context-fabric. The laptop forwards it to its LOCAL gateway and returns the
// gateway RESPONSE as the ResponseFrame payload — the same shape the cloud path
// returns, so context-fabric parses both with ChatResponse.from_dict.
export const ModelRunFrame = z.object({
  type:        z.literal("model-run"),
  request_id:  z.string(),
  payload:     z.record(z.unknown()),   // gateway chat-completions request body
  deadline_ms: z.number().int().positive().optional(),
});
export type ModelRunFrame = z.infer<typeof ModelRunFrame>;

// Code-context build over the bridge (laptop world model). The payload is the
// /mcp/code-context/build REQUEST body (task_text, max_token_budget,
// run_context, …) built by context-fabric. The laptop runs
// buildCodeContextPackage against its LOCAL per-workitem worktree and returns
// the { success, data } envelope as the ResponseFrame payload — the same shape
// the HTTP route returns, so context-fabric parses both transports identically.
export const CodeContextFrame = z.object({
  type:        z.literal("code-context"),
  request_id:  z.string(),
  payload:     z.record(z.unknown()),   // code-context/build request body
  deadline_ms: z.number().int().positive().optional(),
});
export type CodeContextFrame = z.infer<typeof CodeContextFrame>;

// ── decoded inbound ─────────────────────────────────────────────────────────

export type InboundFrame =
  | AuthAckFrame
  | InvokeFrame
  | ToolRunFrame      // M75 Slice 1
  | ModelRunFrame     // LLM-on-laptop
  | CodeContextFrame  // world-model-on-laptop
  | PingFrame
  | DisconnectFrame;

export function decodeInbound(raw: unknown): InboundFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "auth.ack")     return AuthAckFrame.parse(raw);
  if (type === "invoke")       return InvokeFrame.parse(raw);
  if (type === "tool-run")     return ToolRunFrame.parse(raw);     // M75 Slice 1
  if (type === "model-run")    return ModelRunFrame.parse(raw);    // LLM-on-laptop
  if (type === "code-context") return CodeContextFrame.parse(raw); // world-model-on-laptop
  if (type === "ping")         return PingFrame.parse(raw);
  if (type === "disconnect")   return DisconnectFrame.parse(raw);
  return null;
}
