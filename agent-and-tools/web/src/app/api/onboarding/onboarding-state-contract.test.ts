import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/app/api/onboarding/state/route.ts");

assert.match(
  source,
  /const parsed = JSON\.parse\(decoded\) as unknown;[\s\S]*?return sanitizeState\(parsed\);/,
  "onboarding cookie restore should parse JSON as unknown before sanitizing",
);

assert.doesNotMatch(
  source,
  /JSON\.parse\(decoded\) as Partial<OnboardingState>/,
  "onboarding cookie restore must not cast parsed JSON directly to OnboardingState",
);

assert.match(
  source,
  /function sanitizeState\(value: unknown\): OnboardingState[\s\S]*?const record = isRecord\(value\) \? value : \{\};/,
  "onboarding state sanitizer should accept unknown values and fall back for non-objects",
);

assert.match(
  source,
  /function stringArray\(value: unknown, maxItems = 80, maxLength = 120\): string\[\][\s\S]*?boundedString\(item, maxLength\)[\s\S]*?\.slice\(0, maxItems\)/,
  "onboarding string arrays should be bounded, deduped, and reject non-string junk",
);

assert.match(
  source,
  /function timestampString\(value: unknown\): string \| undefined[\s\S]*?Number\.isNaN\(Date\.parse\(text\)\) \? undefined : text;/,
  "onboarding updatedAt should only preserve parseable timestamp strings",
);

assert.match(
  source,
  /const body = isRecord\(requestBody\.data\) \? requestBody\.data : \{\};/,
  "onboarding POST should merge only object request bodies into persisted state",
);

console.log("onboarding state contract tests passed");
