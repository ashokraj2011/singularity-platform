import assert from "node:assert/strict";
import {
  agentSkillSourceKey,
  normalizedAgentSkillSourceValue,
} from "./agent-skill-source-identity";

assert.equal(normalizedAgentSkillSourceValue(" https://docs.example/runbook.md "), "https://docs.example/runbook.md");
assert.equal(
  agentSkillSourceKey({
    skillId: " SKILL-1 ",
    sourceType: " URL_DOCUMENT ",
    sourceRef: " HTTPS://docs.example/runbook.md ",
    capabilityId: " CAP-1 ",
  }),
  "agent-skill-source:skill-1:url_document:https://docs.example/runbook.md:cap-1",
);
assert.equal(
  agentSkillSourceKey({
    skillId: "skill-1",
    sourceType: "local",
  }),
  "agent-skill-source:skill-1:local::",
);
assert.equal(agentSkillSourceKey({ skillId: "", sourceType: "local" }), null);
assert.equal(agentSkillSourceKey({ skillId: "skill-1", sourceType: " " }), null);

console.log("agent skill source identity contract tests passed");
