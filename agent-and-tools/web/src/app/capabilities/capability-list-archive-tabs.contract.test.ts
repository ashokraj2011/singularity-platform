import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/capabilities/page.tsx"), "utf8");
const model = fs.readFileSync(path.join(process.cwd(), "src/app/capabilities/capability-list-model.ts"), "utf8");
const api = fs.readFileSync(path.join(process.cwd(), "src/lib/api.ts"), "utf8");

assert.match(
  api,
  /listCapabilities: \(opts\?: \{ includeArchived\?: boolean \}\) => \{[\s\S]*?opts\?\.includeArchived \? "\?includeArchived=true" : ""[\s\S]*?`?\$?\{?RUNTIME_BASE\}?\/capabilities/,
  "runtimeApi.listCapabilities should require an explicit includeArchived option",
);

assert.match(
  page,
  /useSWR\("runtime-capabilities-with-archive"[\s\S]*?runtimeApi\.listCapabilities\(\{ includeArchived: true \}\)/,
  "capabilities page should explicitly request archived rows for the archive tab",
);

assert.match(
  page,
  /const activeRawItems = useMemo\([\s\S]*?items\.filter\(cap => !isArchivedCapability\(cap\)\)[\s\S]*?const archivedRawItems = useMemo\([\s\S]*?items\.filter\(isArchivedCapability\)/,
  "capabilities page should split active and archived rows into separate tabs",
);

assert.match(
  page,
  /import \{[\s\S]*capabilityDisplayName,[\s\S]*capabilityIdentityKey,[\s\S]*capabilityIdentityLabel,[\s\S]*capabilityRowId,[\s\S]*capabilityRowsFromListResponse,[\s\S]*capabilityShortId,[\s\S]*capabilityText,[\s\S]*duplicateCapabilitiesByIdentity,[\s\S]*isArchivedCapability,[\s\S]*uniqueCapabilitiesByIdentity,[\s\S]*\} from "\.\/capability-list-model";/,
  "capabilities page should use the shared capability list model helpers",
);

assert.match(
  page,
  /const items = useMemo\(\(\) => capabilityRowsFromListResponse\(data\), \[data\]\);/,
  "capabilities page should normalize list API envelopes before splitting active and archived rows",
);

assert.doesNotMatch(
  page,
  /const items = \(data \?\? \[\]\) as Record<string, unknown>\[\]/,
  "capabilities page should not blindly cast list API data to rows",
);

assert.match(
  page,
  /const rowId = capabilityRowId\(c\);[\s\S]*?if \(!rowId\) return null;[\s\S]*?href=\{`\/capabilities\/\$\{encodeURIComponent\(rowId\)\}`\}/,
  "capability cards should use normalized row ids and avoid broken undefined links",
);

assert.match(
  page,
  /Duplicate capability identities detected[\s\S]*?Showing the deterministic canonical row for each app\/name identity[\s\S]*?hiddenDuplicateCount/,
  "capabilities page should explain deterministic hidden duplicate identities instead of silently de-duping",
);

assert.match(
  page,
  /const activeDuplicateGroups = useMemo\([\s\S]*?duplicateCapabilitiesByIdentity\(activeRawItems\)[\s\S]*?const archivedDuplicateGroups = useMemo\([\s\S]*?duplicateCapabilitiesByIdentity\(archivedRawItems\)/,
  "capabilities page should detect duplicate natural identities separately for active and archived rows before rendering",
);

assert.match(
  model,
  /export function capabilityRowsFromListResponse\(value: unknown\): CapabilityRow\[\] \{[\s\S]*?firstArrayField\(value, "items", "capabilities", "data", "rows"\)[\s\S]*?rows\.filter\(isRecord\)/,
  "capability list model should normalize bare arrays and common list envelopes before the page renders rows",
);

assert.match(
  model,
  /export function capabilityRowId\(capability: CapabilityRow\): string \{[\s\S]*?capabilityString\(capability, "id", "capabilityId", "capability_id"\)/,
  "capability list model should expose a normalized row id helper",
);

assert.match(
  model,
  /export function capabilityIdentityKey\(capability: CapabilityRow\): string \{[\s\S]*?capability:app:\$\{appId\}[\s\S]*?capability:name:\$\{type\}:\$\{name\}/,
  "capability list model should use backend-style natural identity keys for app and name/type capabilities",
);

assert.match(
  model,
  /export function uniqueCapabilitiesByIdentity\(capabilities: CapabilityRow\[\]\): CapabilityRow\[\] \{[\s\S]*?const canonicalByKey = canonicalCapabilitiesByIdentity\(capabilities\)[\s\S]*?capabilityCanCollapseByIdentity\(capability\) \? capabilityIdentityKey\(capability\) : ""[\s\S]*?canonicalByKey\.get\(key\) !== capability/,
  "capability list model should de-dupe collapsible lifecycle rows by deterministic canonical identity, not whichever duplicate arrives first",
);

assert.match(
  model,
  /export function duplicateCapabilitiesByIdentity\(capabilities: CapabilityRow\[\]\): CapabilityDuplicateGroup\[\] \{[\s\S]*?const rawGroups = Array\.from\(groups\.entries\(\)\)[\s\S]*?duplicateGroupFromCanonical\(key, ordered\[0\], ordered\.slice\(1\)\)[\s\S]*?serverCollapsedDuplicateGroups\(capabilities\)[\s\S]*?mergeDuplicateGroups/,
  "duplicate warnings should merge raw duplicate rows with server-collapsed duplicate metadata",
);

assert.match(
  model,
  /function serverCollapsedDuplicateGroups\(capabilities: CapabilityRow\[\]\): CapabilityDuplicateGroup\[\] \{[\s\S]*?duplicateCapabilityIds[\s\S]*?duplicate_capability_ids[\s\S]*?duplicateCapabilityCount[\s\S]*?duplicate_capability_count/,
  "capabilities page should surface backend duplicateCapabilityIds metadata after server-side collapse",
);

assert.match(
  model,
  /function duplicateGroupFromCanonical\([\s\S]*?serverDuplicateIds: string\[\] = capabilityStringArray\(canonical, "duplicateCapabilityIds", "duplicate_capability_ids"\)[\s\S]*?duplicateCount: Math\.max\(ids\.size, duplicates\.length, serverDuplicateCount\)/,
  "duplicate group construction should count both raw duplicates and server-reported hidden rows",
);

assert.match(
  model,
  /function mergeDuplicateGroups\(a: CapabilityDuplicateGroup, b: CapabilityDuplicateGroup\): CapabilityDuplicateGroup \{[\s\S]*?const canonical = compareCanonicalCapabilities\(a\.canonical, b\.canonical\) <= 0 \? a\.canonical : b\.canonical[\s\S]*?ids\.delete\(canonicalId\)/,
  "duplicate group merge should avoid double counting canonical ids when raw rows and server metadata overlap",
);

assert.match(
  model,
  /function compareCanonicalCapabilities\(a: CapabilityRow, b: CapabilityRow\): number \{[\s\S]*?const aCreated = capabilityTimestamp\(a, "createdAt", "created_at"\)[\s\S]*?if \(aCreated !== bCreated\) return aCreated - bCreated[\s\S]*?String\(a\.id \?\? ""\)\.localeCompare/,
  "canonical duplicate selection should mirror the backend active-identity migration by preferring oldest created row, then stable id",
);

assert.match(
  model,
  /function capabilityCanCollapseByIdentity\(capability: CapabilityRow\): boolean \{[\s\S]*?const status = capabilityString\(capability, "status"\)\.toUpperCase\(\);[\s\S]*?status !== "DRAFT" && status !== "INACTIVE"/,
  "capabilities page duplicate logic should mirror the backend by passing draft/inactive rows through",
);

assert.doesNotMatch(
  page,
  /function capabilityIdentityKey|function duplicateCapabilitiesByIdentity|function uniqueCapabilitiesByIdentity/,
  "capabilities page should not re-define list identity helpers inline",
);

console.log("capability list archive tabs contract tests passed");
