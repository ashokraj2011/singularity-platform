import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/audit/page.tsx"), "utf8");

assert.match(
  source,
  /const AUDIT_SEVERITIES = new Set<AuditSeverity>\(\["info", "warn", "error", "audit"\]\);[\s\S]*?const AUDIT_RISK_LEVELS = new Set<AuditRiskLevel>\(\["low", "medium", "high", "critical"\]\);/,
  "audit saved-search restore should keep explicit allowed severity and risk vocabularies",
);

assert.match(
  source,
  /function normalizedStringArray\(value: unknown, maxItems = 20, maxLength = 120\): string\[\] \| undefined[\s\S]*?Array\.isArray\(value\)[\s\S]*?item\.trim\(\)\.slice\(0, maxLength\)[\s\S]*?\.slice\(0, maxItems\)/,
  "audit saved-search restore should normalize and bound free-form string arrays",
);

assert.match(
  source,
  /function normalizedEnumArray<T extends string>\(value: unknown, allowed: Set<T>, maxItems = 12\): T\[\] \| undefined[\s\S]*?allowed\.has\(item as T\)[\s\S]*?\.slice\(0, maxItems\)/,
  "audit saved-search restore should keep only allowed enum values",
);

assert.match(
  source,
  /function normalizeSavedSearch\(value: unknown\): SavedSearch \| null[\s\S]*?typeof value\.name !== "string"[\s\S]*?value\.name\.trim\(\)\.slice\(0, 80\)[\s\S]*?value\.q\.trim\(\)\.slice\(0, 500\)/,
  "audit saved-search restore should require a named object and bound free-text query content",
);

assert.match(
  source,
  /function parseSavedSearches\(raw: string \| null\): SavedSearch\[\][\s\S]*?JSON\.parse\(raw\) as unknown[\s\S]*?!Array\.isArray\(parsed\)[\s\S]*?const byName = new Map<string, SavedSearch>\(\);[\s\S]*?if \(byName\.size >= 30\) break;/,
  "audit saved-search restore should safely parse arrays, de-duplicate by name, and bound restored entries",
);

assert.match(
  source,
  /return parseSavedSearches\(localStorage\.getItem\(SAVED_SEARCHES_KEY\)\);/,
  "audit page should restore saved searches through the sanitizer",
);

assert.match(
  source,
  /const normalizedName = name\?\.trim\(\)\.slice\(0, 80\);[\s\S]*?kinds: normalizedStringArray\(selectedKinds\)[\s\S]*?severities: normalizedEnumArray\(selectedSeverities, AUDIT_SEVERITIES\)[\s\S]*?riskLevels: normalizedEnumArray\(selectedRisks, AUDIT_RISK_LEVELS\)/,
  "audit page should sanitize newly saved search names and filter arrays",
);

assert.doesNotMatch(
  source,
  /JSON\.parse\(raw\) as SavedSearch\[\]/,
  "audit page should not cast arbitrary localStorage JSON into saved searches",
);

console.log("audit saved-search contract tests passed");
