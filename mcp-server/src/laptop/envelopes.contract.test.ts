import assert from "node:assert/strict";
import { HeartbeatFrame } from "./envelopes";

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

console.log("mcp runtime bridge envelope contract tests passed");
