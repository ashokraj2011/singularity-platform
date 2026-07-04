import assert from "node:assert/strict";
import {
  AuthAckFrame,
  HeartbeatFrame,
  RUNTIME_BRIDGE_MAX_CONCURRENT_INVOKES,
  SUPPORTED_FRAME_TYPES,
} from "./envelopes";

assert.deepEqual(SUPPORTED_FRAME_TYPES, [
  "invoke",
  "tool-run",
  "model-run",
  "code-context",
  "source-tree",
  "source-file",
  "work-finish-branch",
  "worktree-write-file",
]);

const parsed = HeartbeatFrame.parse({
  type: "heartbeat",
  sent_at: "2026-07-02T00:00:00.000Z",
  health: {
    llm_gateway_url_configured: true,
    llm_providers: [
      { name: "mock", ready: true },
      { name: "copilot", ready: false, warnings: ["Missing credential"] },
    ],
    llm_models: [
      { id: "mock-fast", provider: "mock", ready: true, default: true },
    ],
  },
});

assert.equal(parsed.health?.llm_gateway_url_configured, true);
assert.equal((parsed.health?.llm_providers as unknown[]).length, 2);

assert.equal(RUNTIME_BRIDGE_MAX_CONCURRENT_INVOKES, 32);
assert.equal(AuthAckFrame.parse({
  type: "auth.ack",
  user_id: "u1",
  device_id: "d1",
  registered_at: "2026-07-04T00:00:00.000Z",
  max_concurrent_invokes: RUNTIME_BRIDGE_MAX_CONCURRENT_INVOKES,
}).max_concurrent_invokes, RUNTIME_BRIDGE_MAX_CONCURRENT_INVOKES);

assert.throws(() => AuthAckFrame.parse({
  type: "auth.ack",
  user_id: "u1",
  device_id: "d1",
  registered_at: "2026-07-04T00:00:00.000Z",
  max_concurrent_invokes: RUNTIME_BRIDGE_MAX_CONCURRENT_INVOKES + 1,
}));

console.log("mcp runtime bridge envelope contract tests passed");
