import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/capabilities/[id]/page.tsx"), "utf8");

assert.match(
  page,
  /setData\(normalizeDebugResponse\(parsed\)\);/,
  "tuning debug retrieval should normalize backend responses before rendering",
);

assert.match(
  page,
  /function TuningTab\(\{ capabilityId, disabled \}: \{ capabilityId: string; disabled\?: boolean \}\)[\s\S]*?const runInFlightRef = useRef\(false\);[\s\S]*?async function run\(\) \{[\s\S]*?if \(!task\.trim\(\) \|\| runInFlightRef\.current \|\| disabled\) return;[\s\S]*?runInFlightRef\.current = true;[\s\S]*?fetch\(apiPath\(COMPOSER_DEBUG_URL\)[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "request failed"\)\);[\s\S]*?runInFlightRef\.current = false;/,
  "tuning debug retrieval should use an immediate in-flight/archive guard and normalized error feedback",
);

assert.match(
  page,
  /<TuningTab capabilityId=\{id\} disabled=\{isArchived\} \/>[\s\S]*?disabled=\{busy \|\| disabled\}[\s\S]*?disabled=\{busy \|\| disabled \|\| !task\.trim\(\)\}[\s\S]*?Archived capabilities are read-only/,
  "archived capability detail should disable tuning debug retrieval and explain the read-only state",
);

assert.match(
  page,
  /function normalizeDebugResponse\(value: unknown\): DebugResponse \{[\s\S]*?const record = asObject\(value\);[\s\S]*?knowledge: asObjectArray\(record\.knowledge\)\.map[\s\S]*?memory: asObjectArray\(record\.memory\)\.map[\s\S]*?code: asObjectArray\(record\.code\)\.map/,
  "tuning debug response normalization should tolerate missing or malformed result arrays",
);

assert.match(
  page,
  /function normalizeDebugHit\(value: Record<string, unknown>\): DebugHit \{[\s\S]*?cosineSimilarity: capabilityNumber\(value\.cosineSimilarity, Number\.NaN\)[\s\S]*?ageDays: capabilityNumber\(value\.ageDays, Number\.NaN\)[\s\S]*?finalScore: capabilityNumber\(value\.finalScore, Number\.NaN\)/,
  "tuning debug hit normalization should preserve non-finite scores for safe n/a rendering",
);

assert.match(
  page,
  /function formatScore\(value: number, digits: number\): string \{[\s\S]*?Number\.isFinite\(value\) \? value\.toFixed\(digits\) : "n\/a";[\s\S]*?cos <strong>\{formatScore\(h\.cosineSimilarity, 3\)\}<\/strong>[\s\S]*?score <strong>\{formatScore\(h\.finalScore, 3\)\}<\/strong>/,
  "tuning debug score rendering should avoid direct toFixed calls on untrusted response values",
);

console.log("capability tuning debug normalization contract tests passed");
