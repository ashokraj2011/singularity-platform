import assert from "node:assert/strict";
import {
  capabilityDuplicateConflictMessage,
  capabilityDuplicateWhere,
  capabilityNaturalKey,
} from "./capability-identity";

assert.equal(
  capabilityNaturalKey({ appId: " AP3456 ", name: "RuleEngineTesting", capabilityType: "DELIVERY" }),
  "capability:app:ap3456",
  "appId is the primary natural key when present",
);

assert.equal(
  capabilityNaturalKey({ name: " RuleEngineTesting ", capabilityType: " DELIVERY " }),
  "capability:name:delivery:ruleenginetesting",
  "name + capability type form the natural key when appId is absent",
);

assert.equal(
  capabilityNaturalKey({ name: "RuleEngineTesting" }),
  "capability:name:default:ruleenginetesting",
  "capability type defaults consistently for name-only capabilities",
);

assert.deepEqual(
  capabilityDuplicateWhere({ appId: " AP3456 ", name: "Ignored" }),
  {
    status: "ACTIVE",
    appId: { equals: "AP3456", mode: "insensitive" },
  },
  "duplicate lookup should match active appId case-insensitively",
);

assert.deepEqual(
  capabilityDuplicateWhere({ name: " RuleEngineTesting ", capabilityType: " Delivery " }, "cap-1"),
  {
    status: "ACTIVE",
    id: { not: "cap-1" },
    name: { equals: "RuleEngineTesting", mode: "insensitive" },
    OR: [{ capabilityType: { equals: "Delivery", mode: "insensitive" } }],
  },
  "update duplicate lookup should exclude the current row",
);

assert.deepEqual(
  capabilityDuplicateWhere({ name: "RuleEngineTesting" }),
  {
    status: "ACTIVE",
    name: { equals: "RuleEngineTesting", mode: "insensitive" },
    OR: [
      { capabilityType: null },
      { capabilityType: "" },
      { capabilityType: { equals: "default", mode: "insensitive" } },
    ],
  },
  "name-only duplicate lookup should use the default capability type bucket",
);

assert.equal(
  capabilityDuplicateWhere({ name: "  ", appId: "" }),
  null,
  "blank identity should not produce a duplicate query",
);

assert.match(
  capabilityDuplicateConflictMessage({ id: "cap-123", name: "RuleEngineTesting", appId: "AP3456" }),
  /appId AP3456.*cap-123/,
);

assert.match(
  capabilityDuplicateConflictMessage({ id: "cap-456", name: "RuleEngineTesting" }),
  /name RuleEngineTesting.*cap-456/,
);

console.log("capability identity contract tests passed");
