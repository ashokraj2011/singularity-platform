import assert from "node:assert/strict";
import {
  capabilityDisplayName,
  capabilityIdentityKey,
  capabilityIdentityLabel,
  capabilityRowId,
  capabilityRowsFromListResponse,
  capabilityShortId,
  capabilityText,
  duplicateCapabilitiesByIdentity,
  isArchivedCapability,
  uniqueCapabilitiesByIdentity,
  type CapabilityRow,
} from "./capability-list-model";

function row(input: CapabilityRow): CapabilityRow {
  return {
    name: "RuleEngineTesting",
    appId: "AP3456",
    capabilityType: "DELIVERY",
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

const activeOriginal = row({ id: "active-original", createdAt: "2026-01-01T00:00:00.000Z" });
const activeRetry = row({ id: "active-retry", appId: " ap3456 ", createdAt: "2026-01-02T00:00:00.000Z" });
const activeServerCollapsed = row({
  id: "active-server",
  appId: "AP9999",
  duplicateCapabilityIds: ["server-hidden-1", "server-hidden-2"],
  duplicateCapabilityCount: "2",
});
const activeServerOverlap = row({
  id: "active-original",
  duplicateCapabilityIds: ["active-retry", "active-original"],
  duplicateCapabilityCount: 2,
});
const archivedOriginal = row({ id: "archived-original", status: "ARCHIVED", createdAt: "2026-01-03T00:00:00.000Z" });
const archivedRetry = row({ id: "archived-retry", status: "ARCHIVED", createdAt: "2026-01-04T00:00:00.000Z" });
const draftOriginal = row({ id: "draft-original", status: "DRAFT", createdAt: "2026-01-05T00:00:00.000Z" });
const draftRetry = row({ id: "draft-retry", status: "DRAFT", createdAt: "2026-01-06T00:00:00.000Z" });
const inactiveOriginal = row({ id: "inactive-original", status: "INACTIVE", createdAt: "2026-01-07T00:00:00.000Z" });
const inactiveRetry = row({ id: "inactive-retry", status: "INACTIVE", createdAt: "2026-01-08T00:00:00.000Z" });
const noIdentity = row({ id: "no-identity", appId: "", name: "" });

assert.equal(isArchivedCapability(archivedOriginal), true);
assert.equal(isArchivedCapability(activeOriginal), false);

assert.equal(
  capabilityIdentityKey(activeRetry),
  "capability:app:ap3456",
  "appId should be the primary capability identity and should be normalized",
);

assert.equal(
  capabilityIdentityKey(row({ id: "name-only", appId: "", name: " RuleEngineTesting ", capabilityType: " Delivery " })),
  "capability:name:delivery:ruleenginetesting",
  "name/type should be used when appId is absent",
);

assert.equal(capabilityIdentityKey(noIdentity), "");

assert.deepEqual(
  uniqueCapabilitiesByIdentity([activeRetry, activeOriginal, noIdentity]).map(item => item.id),
  ["active-original", "no-identity"],
  "visible active rows should keep the earliest canonical identity row plus non-identity rows",
);

assert.deepEqual(
  uniqueCapabilitiesByIdentity([archivedRetry, archivedOriginal]).map(item => item.id),
  ["archived-original"],
  "visible archived rows should be de-duped after the page splits lifecycle tabs",
);

assert.deepEqual(
  uniqueCapabilitiesByIdentity([draftRetry, draftOriginal, inactiveRetry, inactiveOriginal]).map(item => item.id),
  ["draft-retry", "draft-original", "inactive-retry", "inactive-original"],
  "draft and inactive rows should pass through instead of being hidden by identity collapse",
);

const duplicateGroups = duplicateCapabilitiesByIdentity([
  activeRetry,
  activeOriginal,
  activeServerOverlap,
  activeServerCollapsed,
]);

const activeGroup = duplicateGroups.find(group => group.key === "capability:app:ap3456");
assert.ok(activeGroup, "raw active duplicate rows should create an active duplicate group");
assert.equal(activeGroup.canonical.id, "active-original");
assert.deepEqual(activeGroup.duplicateIds.sort(), ["active-retry"]);
assert.equal(activeGroup.duplicateCount, 2, "server count should be preserved even when raw ids overlap");

const serverGroup = duplicateGroups.find(group => group.key === "capability:app:ap9999");
assert.ok(serverGroup, "server-collapsed duplicate metadata should create a duplicate group");
assert.deepEqual(serverGroup.duplicateIds, ["server-hidden-1", "server-hidden-2"]);
assert.equal(serverGroup.duplicateCount, 2);

const archivedGroup = duplicateCapabilitiesByIdentity([archivedRetry, archivedOriginal])[0];
assert.ok(archivedGroup, "archived duplicates should remain separate when caller passes archived rows");
assert.equal(archivedGroup.canonical.id, "archived-original");
assert.deepEqual(archivedGroup.duplicateIds, ["archived-retry"]);

assert.deepEqual(
  duplicateCapabilitiesByIdentity([draftRetry, draftOriginal, inactiveRetry, inactiveOriginal]),
  [],
  "draft and inactive rows should not emit duplicate warnings because the backend intentionally passes them through",
);

assert.equal(capabilityIdentityLabel(activeOriginal), "app: AP3456");
assert.equal(capabilityShortId("1234567890"), "12345678");
assert.equal(capabilityRowId(row({ id: 1234 })), "1234");
assert.equal(capabilityDisplayName(row({ id: "fallback-name", name: "" })), "fallback-name");
assert.equal(capabilityText({ app_id: "APP-2" }, "appId", "app_id"), "APP-2");

assert.deepEqual(
  capabilityRowsFromListResponse([activeOriginal, "bad", null, activeRetry]).map(item => item.id),
  ["active-original", "active-retry"],
  "bare capability arrays should filter non-object rows",
);

assert.deepEqual(
  capabilityRowsFromListResponse({ items: [activeOriginal] }).map(item => item.id),
  ["active-original"],
  "items envelopes should normalize to capability rows",
);

assert.deepEqual(
  capabilityRowsFromListResponse({ capabilities: [archivedOriginal] }).map(item => item.id),
  ["archived-original"],
  "capabilities envelopes should normalize to capability rows",
);

assert.deepEqual(
  capabilityRowsFromListResponse({ data: [activeServerCollapsed] }).map(item => item.id),
  ["active-server"],
  "data envelopes should normalize to capability rows",
);

assert.deepEqual(
  capabilityRowsFromListResponse({ status: "error", message: "not json list" }),
  [],
  "non-list envelopes should fail closed to an empty capability list",
);

console.log("capability list model contract tests passed");
