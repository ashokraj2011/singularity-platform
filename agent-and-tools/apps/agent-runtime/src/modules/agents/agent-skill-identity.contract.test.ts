import assert from "node:assert/strict";
import {
  agentSkillKey,
  normalizedAgentSkillIdentityValue,
} from "./agent-skill-identity";

assert.equal(normalizedAgentSkillIdentityValue(" Test Runner "), "Test Runner");
assert.equal(
  agentSkillKey({ name: " Test Runner ", skillType: " TOOL " }),
  "agent-skill:tool:test runner:",
);
assert.equal(
  agentSkillKey({ name: " Test Runner ", skillType: " TOOL ", promptLayerId: " PROMPT-1 " }),
  "agent-skill:tool:test runner:prompt-1",
);
assert.equal(agentSkillKey({ name: "", skillType: "TOOL" }), null);
assert.equal(agentSkillKey({ name: "Test Runner", skillType: " " }), null);

console.log("agent skill identity contract tests passed");
