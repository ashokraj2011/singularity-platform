import assert from "node:assert/strict";
import {
  capabilityListIdentityBucket,
  capabilityListStatusRank,
  collapseCapabilityListDuplicates,
  compareCapabilityListDisplay,
  compareCapabilityListCanonical,
  type CapabilityListIdentityRow,
} from "./capability-list-identity";

function row(input: Partial<CapabilityListIdentityRow> & { id: string }): CapabilityListIdentityRow {
  return {
    id: input.id,
    name: hasOwn(input, "name") ? input.name ?? null : "RuleEngineTesting",
    appId: hasOwn(input, "appId") ? input.appId ?? null : "AP3456",
    capabilityType: hasOwn(input, "capabilityType") ? input.capabilityType ?? null : "DELIVERY",
    status: input.status ?? "ACTIVE",
    createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const activeOriginal = row({ id: "active-original", createdAt: new Date("2026-01-01T00:00:00.000Z") });
const activeRetry = row({ id: "active-retry", createdAt: new Date("2026-01-02T00:00:00.000Z"), appId: " ap3456 " });
const archivedOriginal = row({ id: "archived-original", status: "ARCHIVED", createdAt: new Date("2026-01-03T00:00:00.000Z") });
const archivedRetry = row({ id: "archived-retry", status: "ARCHIVED", createdAt: new Date("2026-01-04T00:00:00.000Z") });
const draftWithoutIdentity = row({ id: "draft-without-identity", status: "DRAFT", appId: "", name: "" });
const inactiveWithoutIdentity = row({ id: "inactive-without-identity", status: "INACTIVE", appId: "", name: "" });

assert.equal(
  capabilityListIdentityBucket(activeRetry),
  "ACTIVE:capability:app:ap3456",
  "appId identity bucket should be status-scoped and case-insensitive",
);

assert.equal(
  capabilityListIdentityBucket(row({ id: "name-only", appId: null, name: " RuleEngineTesting ", capabilityType: " Delivery " })),
  "ACTIVE:capability:name:delivery:ruleenginetesting",
  "name/type identity bucket should be status-scoped and normalized",
);

assert.equal(
  capabilityListIdentityBucket(draftWithoutIdentity),
  null,
  "draft rows should pass through list collapse instead of forming blank duplicate groups",
);

assert.equal(
  compareCapabilityListCanonical(activeOriginal, activeRetry),
  -86400000,
  "canonical ordering should prefer the earliest created row",
);

assert.equal(capabilityListStatusRank("ACTIVE"), 0);
assert.equal(capabilityListStatusRank("DRAFT"), 1);
assert.equal(capabilityListStatusRank("INACTIVE"), 2);
assert.equal(capabilityListStatusRank("ARCHIVED"), 3);
assert.ok(
  compareCapabilityListDisplay(archivedRetry, activeOriginal) > 0,
  "display ordering should put active rows before archived history even when archived rows are newer",
);

const collapsed = collapseCapabilityListDuplicates([
  activeRetry,
  archivedRetry,
  draftWithoutIdentity,
  activeOriginal,
  inactiveWithoutIdentity,
  archivedOriginal,
]);

assert.deepEqual(
  collapsed.map(item => item.id),
  ["active-original", "draft-without-identity", "inactive-without-identity", "archived-original"],
  "collapse should keep one canonical row per active/archived identity bucket and sort active work before archived history",
);

assert.deepEqual(
  collapsed.find(item => item.id === "active-original")?.duplicateCapabilityIds,
  ["active-retry"],
  "active duplicate ids should be attached to the canonical active row",
);

assert.deepEqual(
  collapsed.find(item => item.id === "archived-original")?.duplicateCapabilityIds,
  ["archived-retry"],
  "archived duplicate ids should be attached to the canonical archived row without hiding active history",
);

assert.equal(
  collapsed.find(item => item.id === "active-original")?.duplicateCapabilityCount,
  1,
  "duplicate count should match the number of hidden active rows",
);

console.log("capability list identity contract tests passed");
