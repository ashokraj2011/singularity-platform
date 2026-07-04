import assert from "node:assert/strict";
import {
  agentTemplateSkillKey,
  normalizedAgentTemplateSkillValue,
} from "./agent-template-skill-identity";

assert.equal(normalizedAgentTemplateSkillValue(" template-1 "), "template-1");
assert.equal(
  agentTemplateSkillKey({
    agentTemplateId: " TEMPLATE-1 ",
    skillId: " SKILL-1 ",
    sourceType: " URL_DOCUMENT ",
    sourceRef: " HTTPS://docs.example/runbook.md ",
    capabilityId: " CAP-1 ",
  }),
  "agent-template-skill:template-1:skill-1:url_document:https://docs.example/runbook.md:cap-1",
);
assert.equal(
  agentTemplateSkillKey({
    agentTemplateId: "template-1",
    skillId: "skill-1",
    sourceType: "local",
  }),
  "agent-template-skill:template-1:skill-1:local::",
);
assert.equal(agentTemplateSkillKey({ agentTemplateId: "", skillId: "skill-1", sourceType: "local" }), null);
assert.equal(agentTemplateSkillKey({ agentTemplateId: "template-1", skillId: "", sourceType: "local" }), null);
assert.equal(agentTemplateSkillKey({ agentTemplateId: "template-1", skillId: "skill-1", sourceType: " " }), null);

console.log("agent template skill identity contract tests passed");
