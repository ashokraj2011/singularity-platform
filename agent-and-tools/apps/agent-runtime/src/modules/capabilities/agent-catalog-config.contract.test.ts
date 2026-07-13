import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_CATALOG,
  parseAgentCatalog,
  loadAgentCatalog,
  resetAgentCatalogCache,
} from "./agent-catalog-config";

// 1. The compiled-in default preserves the historical 9-agent catalog + 3 presets exactly.
assert.equal(DEFAULT_AGENT_CATALOG.agents.length, 9);
assert.deepEqual(
  DEFAULT_AGENT_CATALOG.agents.map((a) => a.key),
  ["product_owner", "business_analyst", "architect", "developer", "verifier", "qa", "security", "devops", "governance"],
);
assert.equal(DEFAULT_AGENT_CATALOG.defaultPreset, "governed_delivery");
assert.deepEqual(Object.keys(DEFAULT_AGENT_CATALOG.presets).sort(), ["engineering_core", "governed_delivery", "minimal"]);
assert.deepEqual(DEFAULT_AGENT_CATALOG.presets.minimal.agents, ["product_owner", "architect", "developer", "verifier", "governance"]);
assert.equal(DEFAULT_AGENT_CATALOG.presets.governed_delivery.agents.length, 9);

// Locked activation-required gates + the non-obvious verifier mapping are preserved.
const agent = (key: string) => DEFAULT_AGENT_CATALOG.agents.find((a) => a.key === key)!;
for (const key of ["verifier", "security", "governance"]) {
  assert.equal(agent(key).locked, true, `${key} locked`);
  assert.equal(agent(key).activationRequired, true, `${key} activationRequired`);
}
assert.equal(agent("verifier").roleType, "QA"); // verifier runs as QA...
assert.equal(agent("verifier").bindingRole, "VERIFIER"); // ...but binds as VERIFIER
assert.equal(agent("business_analyst").baseRoleType, "PRODUCT_OWNER"); // BA inherits PO baseline
assert.equal(agent("governance").learnsFromGit, false);

// 2. null/undefined → the built-in default (no warnings).
assert.equal(parseAgentCatalog(null, "test").source, "default");
assert.equal(parseAgentCatalog(undefined, "test").catalog.agents.length, 9);

// 3. A valid override replaces the catalog wholesale.
const override = {
  agents: [
    { key: "lead", label: "Lead", roleType: "ARCHITECT", bindingRole: "ARCHITECT", baseRoleType: "ARCHITECT", locked: false, activationRequired: false, learnsFromGit: true, grounding: "g", description: "d" },
    { key: "gate", label: "Gate", roleType: "GOVERNANCE", bindingRole: "GOVERNANCE", baseRoleType: "GOVERNANCE", locked: true, activationRequired: true, learnsFromGit: false, grounding: "g", description: "d" },
  ],
  presets: { core: { label: "Core", agents: ["lead"] } },
  defaultPreset: "core",
};
const good = parseAgentCatalog(override, "AGENT_CATALOG_JSON");
assert.equal(good.source, "AGENT_CATALOG_JSON");
assert.equal(good.warnings.length, 0);
assert.deepEqual(good.catalog.agents.map((a) => a.key), ["lead", "gate"]);
assert.equal(good.catalog.defaultPreset, "core");

// 4. A preset that references an unknown agent key → degrade to default + a warning.
const badPreset = { ...override, presets: { core: { label: "Core", agents: ["nope"] } } };
const bad1 = parseAgentCatalog(badPreset, "test");
assert.equal(bad1.source, "degraded-default");
assert.equal(bad1.catalog.agents.length, 9);
assert.ok(bad1.warnings[0].includes("unknown agent key"), "warns about unknown key");

// 5. An invalid roleType (not in the AgentRoleType enum) → degrade.
const badRole = { ...override, agents: [{ ...override.agents[0], roleType: "WIZARD" }] };
assert.equal(parseAgentCatalog(badRole, "test").source, "degraded-default");

// 6. defaultPreset missing from presets → degrade.
assert.equal(parseAgentCatalog({ ...override, defaultPreset: "missing" }, "test").source, "degraded-default");

// 7. loadAgentCatalog reads AGENT_CATALOG_JSON from the environment (with cache reset).
process.env.AGENT_CATALOG_JSON = JSON.stringify(override);
resetAgentCatalogCache();
assert.deepEqual(loadAgentCatalog().agents.map((a) => a.key), ["lead", "gate"]);
delete process.env.AGENT_CATALOG_JSON;
resetAgentCatalogCache();
assert.equal(loadAgentCatalog().agents.length, 9);

console.log("agent-catalog-config.contract.test.ts OK");
