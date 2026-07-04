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

const RequestId = z.string().min(1).max(128);

// ── outbound (laptop → bridge) ──────────────────────────────────────────────

// M75 Slice 1 — wire-format frame-type identifiers the laptop understands.
// Bridge inspects hello.supported_frame_types to choose between sending
// legacy "invoke" frames and new "tool-run" frames. Old laptops omit
// the field; .default(["invoke"]) maintains backward compat.
export const SUPPORTED_FRAME_TYPES = ["invoke", "tool-run", "model-run", "code-context", "source-tree", "source-file", "work-finish-branch", "worktree-write-file"] as const;
export type SupportedFrameType = (typeof SUPPORTED_FRAME_TYPES)[number];

export const HelloFrame = z.object({
  type:        z.literal("hello"),
  device_id:   z.string(),
  runtime_id:  z.string().optional(),
  runtime_type: z.string().default("mcp"),
  tenant_id:   z.string().optional(),
  user_id:     z.string().optional(),
  device_name: z.string(),
  agent_version: z.string(),
  capabilities:  z.array(z.string()).default([]),
  capability_tags: z.array(z.string()).default([]),
  shared: z.boolean().optional(),
  runtime_scope: z.string().optional(),
  health: z.record(z.unknown()).optional(),
  // M75 Slice 1 — which bridge → laptop frame types this binary can
  // handle. Defaults to legacy-only so pre-M75 laptops that don't
  // emit the field still get correctly classified.
  supported_frame_types: z.array(z.enum(SUPPORTED_FRAME_TYPES)).default(["invoke"]),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

export const HeartbeatFrame = z.object({
  type: z.literal("heartbeat"),
  sent_at: z.string(),
  health: z.record(z.unknown()).optional(),
});
export type HeartbeatFrame = z.infer<typeof HeartbeatFrame>;

export const ResponseFrame = z.object({
  type:       z.literal("response"),
  request_id: RequestId,
  payload:    z.unknown(),                    // the executeInvokePayload result
  error:      z.object({
    code:    z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
});
export type ResponseFrame = z.infer<typeof ResponseFrame>;

export type OutboundFrame = HelloFrame | HeartbeatFrame | ResponseFrame;

export const RUNTIME_BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeOutboundFrame(
  frame: OutboundFrame,
  maxBytes = RUNTIME_BRIDGE_MAX_FRAME_BYTES,
): { text: string; bytes: number; oversized: boolean } {
  const text = JSON.stringify(frame);
  const bytes = Buffer.byteLength(text, "utf8");
  return { text, bytes, oversized: bytes > maxBytes };
}

export function oversizedResponseFrame(
  frame: ResponseFrame,
  bytes: number,
  maxBytes = RUNTIME_BRIDGE_MAX_FRAME_BYTES,
): ResponseFrame {
  return {
    type: "response",
    request_id: frame.request_id,
    payload: null,
    error: {
      code: "RUNTIME_RESPONSE_TOO_LARGE",
      message: `runtime response exceeded ${maxBytes} bytes`,
      details: { bytes, max_bytes: maxBytes },
    },
  };
}

// ── inbound (bridge → laptop) ───────────────────────────────────────────────

export const AuthAckFrame = z.object({
  type:        z.literal("auth.ack"),
  user_id:     z.string(),
  tenant_id:   z.string().optional(),
  runtime_id:  z.string().optional(),
  runtime_type: z.string().optional(),
  device_id:   z.string(),
  registered_at: z.string(),
  accepted_frame_types: z.array(z.string()).optional(),
  // Optional payload limits / config the bridge wants the laptop to respect.
  max_concurrent_invokes: z.number().int().positive().optional(),
});
export type AuthAckFrame = z.infer<typeof AuthAckFrame>;

export const InvokeFrame = z.object({
  type:       z.literal("invoke"),
  request_id: RequestId,
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
  // Signed ToolInvocationGrant minted by Context Fabric. The laptop relay
  // passes this through to the same transport-neutral runner as HTTP
  // /mcp/tool-run, so mutating/high-risk tools stay grant-bound over WS.
  tool_grant: z.unknown().optional(),
});
export type ToolRunPayload = z.infer<typeof ToolRunPayload>;

export const ToolRunFrame = z.object({
  type:       z.literal("tool-run"),
  request_id: RequestId,
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
  request_id:  RequestId,
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
  request_id:  RequestId,
  payload:     z.record(z.unknown()),   // code-context/build request body
  deadline_ms: z.number().int().positive().optional(),
});
export type CodeContextFrame = z.infer<typeof CodeContextFrame>;

// Repo source discovery over the bridge. Mirrors mcp's HTTP /mcp/source/tree and
// /mcp/source/file 1:1: the laptop runs the GitHub fetch with its LOCAL
// GITHUB_TOKEN and returns the same { tree } / { content } payload, so a cloud
// control plane (agent-runtime capability bootstrap) can discover a repo via the
// user's laptop runtime instead of needing its own GitHub egress / a reachable
// mcp HTTP endpoint.
export const SourceTreeFrame = z.object({
  type:        z.literal("source-tree"),
  request_id:  RequestId,
  payload:     z.object({ repoUrl: z.string(), branch: z.string().default("main") }),
  deadline_ms: z.number().int().positive().optional(),
});
export type SourceTreeFrame = z.infer<typeof SourceTreeFrame>;

export const SourceFileFrame = z.object({
  type:        z.literal("source-file"),
  request_id:  RequestId,
  payload:     z.object({ repoUrl: z.string(), branch: z.string().default("main"), path: z.string() }),
  deadline_ms: z.number().int().positive().optional(),
});
export type SourceFileFrame = z.infer<typeof SourceFileFrame>;

// Finish a work branch over the bridge (CF → laptop). Payload is the
// /mcp/work/finish-branch body; runFinishWorkBranch re-validates it with
// FinishBranchSchema, so keep the envelope loose to avoid coupling envelopes.ts
// to the work-route module.
export const WorkFinishBranchFrame = z.object({
  type:        z.literal("work-finish-branch"),
  request_id:  RequestId,
  payload:     z.record(z.unknown()),
  deadline_ms: z.number().int().positive().optional(),
});
export type WorkFinishBranchFrame = z.infer<typeof WorkFinishBranchFrame>;

// Write+commit a file into a work-item worktree over the bridge (CF → laptop).
// Payload = {workItemCode, path, content, message?, expectedSha?, authorEmail?,
// authorName?}; runWorktreeWriteFile validates it, so keep the envelope loose.
export const WorktreeWriteFileFrame = z.object({
  type:        z.literal("worktree-write-file"),
  request_id:  RequestId,
  payload:     z.record(z.unknown()),
  deadline_ms: z.number().int().positive().optional(),
});
export type WorktreeWriteFileFrame = z.infer<typeof WorktreeWriteFileFrame>;

// ── decoded inbound ─────────────────────────────────────────────────────────

export type InboundFrame =
  | AuthAckFrame
  | InvokeFrame
  | ToolRunFrame      // M75 Slice 1
  | ModelRunFrame     // LLM-on-laptop
  | CodeContextFrame  // world-model-on-laptop
  | SourceTreeFrame   // repo discovery over the bridge
  | SourceFileFrame   // repo discovery over the bridge
  | WorkFinishBranchFrame  // git work-branch finalize over the bridge
  | WorktreeWriteFileFrame  // worktree file write+commit over the bridge
  | PingFrame
  | DisconnectFrame;

export function decodeInbound(raw: unknown): InboundFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "auth.ack")     return parseInbound(AuthAckFrame, raw);
  if (type === "invoke")       return parseInbound(InvokeFrame, raw);
  if (type === "tool-run")     return parseInbound(ToolRunFrame, raw);     // M75 Slice 1
  if (type === "model-run")    return parseInbound(ModelRunFrame, raw);    // LLM-on-laptop
  if (type === "code-context") return parseInbound(CodeContextFrame, raw); // world-model-on-laptop
  if (type === "source-tree")  return parseInbound(SourceTreeFrame, raw);  // repo discovery over the bridge
  if (type === "source-file")  return parseInbound(SourceFileFrame, raw);  // repo discovery over the bridge
  if (type === "work-finish-branch") return parseInbound(WorkFinishBranchFrame, raw); // git finalize over the bridge
  if (type === "worktree-write-file") return parseInbound(WorktreeWriteFileFrame, raw); // worktree write over the bridge
  if (type === "ping")         return parseInbound(PingFrame, raw);
  if (type === "disconnect")   return parseInbound(DisconnectFrame, raw);
  return null;
}

export type RawInboundDecodeResult =
  | { ok: true; frame: InboundFrame; bytes: number }
  | { ok: false; reason: "too-large" | "bad-json" | "invalid-frame"; bytes: number; error?: string };

export function decodeInboundRaw(
  data: unknown,
  maxBytes = RUNTIME_BRIDGE_MAX_FRAME_BYTES,
): RawInboundDecodeResult {
  const buffer = rawDataBuffer(data);
  if (!buffer) return { ok: false, reason: "bad-json", bytes: 0, error: "unsupported message data" };
  const bytes = buffer.byteLength;
  if (bytes > maxBytes) return { ok: false, reason: "too-large", bytes };

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    return { ok: false, reason: "bad-json", bytes, error: (err as Error).message };
  }

  const frame = decodeInbound(parsed);
  if (!frame) return { ok: false, reason: "invalid-frame", bytes };
  return { ok: true, frame, bytes };
}

function parseInbound<T>(
  schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false } },
  raw: unknown,
): T | null {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function rawDataBuffer(data: unknown): Buffer | null {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) {
    const chunks: Buffer[] = [];
    for (const item of data) {
      if (!Buffer.isBuffer(item)) return null;
      chunks.push(item);
    }
    return Buffer.concat(chunks);
  }
  return null;
}
