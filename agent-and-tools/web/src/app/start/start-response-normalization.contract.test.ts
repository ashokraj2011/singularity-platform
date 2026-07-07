import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const page = read("src/app/start/page.tsx");

assert.match(
  page,
  /import \{ asBoolean, asRow, asRowArray, asString, asStringArray \} from "@\/lib\/row";/,
  "start page should use shared row-normalization helpers for API response view models",
);

assert.match(
  page,
  /function normalizeStartPreview\(value: unknown, fallbackStory: string\): StartPreview[\s\S]*?const normalizedBlockers = asRowArray\(row\.blockers\)\.map\(normalizeBlocker\)[\s\S]*?const normalizedWarnings = asRowArray\(row\.warnings\)\.map\(normalizeBlocker\)[\s\S]*?warnings: normalizedWarnings\.length/,
  "start preview response should be normalized from unknown API data before rendering",
);

assert.match(
  page,
  /const warningIssues = preview\?\.warnings\?\.length[\s\S]*?\? preview\.warnings[\s\S]*?: \(preview\?\.blockers \?\? \[\]\)\.filter/,
  "start page should prefer first-class preview warnings over deriving warnings from blockers",
);

assert.match(
  page,
  /function normalizeLaunchResult\(value: unknown\): LaunchResult[\s\S]*?workItems: asRowArray\(row\.workItems\)[\s\S]*?warnings: asStringArray\(row\.warnings\)/,
  "start launch response should normalize work item and warning arrays before rendering",
);

assert.match(
  page,
  /function normalizeOnboardingEnvelope\(value: unknown\): \{ state: OnboardingState \}[\s\S]*?normalizeOnboardingState\(asRow\(value\)\.state\)/,
  "onboarding response envelope should be normalized before setting client state",
);

assert.match(
  page,
  /async function postJson\(path: string, body: unknown\): Promise<unknown>[\s\S]*?return parsed;/,
  "start postJson helper should return unknown parsed data instead of a generic cast",
);

assert.match(
  page,
  /async function getJson\(path: string\): Promise<unknown>[\s\S]*?return parsed;/,
  "start getJson helper should return unknown parsed data instead of a generic cast",
);

assert.doesNotMatch(
  page,
  /postJson<|getJson<|parsed as T|return parsed as/,
  "start page should not cast parsed API responses directly to trusted client types",
);

assert.match(
  page,
  /const data = normalizeStartPreview\(await postJson\("\/api\/start\/preview"[\s\S]*?\), next\.story \?\? story\);/,
  "loadPreview should normalize the preview response before reading recommendation fields",
);

assert.match(
  page,
  /const result = normalizeLaunchResult\(await postJson\("\/api\/start\/launch"/,
  "launch should normalize the launch response before rendering result links",
);

assert.match(
  page,
  /const saved = normalizeOnboardingEnvelope\(await postJson\("\/api\/onboarding\/state", next\)\);[\s\S]*?setOnboarding\(saved\.state\);/,
  "saveOnboarding should normalize saved onboarding state before replacing local state",
);

assert.match(
  page,
  /void getJson\("\/api\/onboarding\/state"\)[\s\S]*?setOnboarding\(normalizeOnboardingEnvelope\(data\)\.state\)/,
  "initial onboarding load should normalize the persisted state envelope",
);

console.log("start response normalization contract tests passed");
