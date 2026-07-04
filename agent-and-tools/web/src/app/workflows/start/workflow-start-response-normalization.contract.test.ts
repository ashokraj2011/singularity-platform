import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const page = read("src/app/workflows/start/page.tsx");

assert.match(
  page,
  /import \{ asBoolean, asRow, asRowArray, asString, asStringArray \} from "@\/lib\/row";/,
  "workflow start should use shared row-normalization helpers",
);

assert.match(
  page,
  /function normalizeGalleryItem\(value: unknown, index: number\): GalleryItem[\s\S]*?requiredInputs: asStringArray\(row\.requiredInputs\)[\s\S]*?workflowTemplate: normalizeWorkflowTemplate\(row\.workflowTemplate\)/,
  "workflow start should normalize intent gallery rows before rendering cards",
);

assert.match(
  page,
  /function normalizeAdoptionHealth\(value: unknown\): AdoptionHealth[\s\S]*?readyModelAliases: asStringArray\(summary\.readyModelAliases\)[\s\S]*?blocked: asRowArray\(row\.blocked\)\.map\(normalizeHealthIssue\)/,
  "workflow start should normalize adoption health and readiness arrays",
);

assert.match(
  page,
  /function normalizeStartPreview\(value: unknown, fallbackStoryText: string\): StartPreview[\s\S]*?intents: asRowArray\(row\.intents\)\.map\(normalizeGalleryItem\)[\s\S]*?blockers: asRowArray\(row\.blockers\)\.map\(normalizeBlocker\)/,
  "workflow start preview response should be normalized from unknown API data",
);

assert.match(
  page,
  /function normalizeLaunchResult\(value: unknown\): LaunchResult[\s\S]*?workItems: asRowArray\(row\.workItems\)[\s\S]*?warnings: asStringArray\(row\.warnings\)/,
  "workflow start launch response should normalize work item and warning arrays",
);

assert.doesNotMatch(
  page,
  /parsed as StartPreview|parsed as LaunchResult|return parsed as|as StartPreview|as LaunchResult/,
  "workflow start should not cast parsed API responses directly to trusted page types",
);

assert.match(
  page,
  /const data = normalizeStartPreview\(parsed, next\.story \?\? story\);[\s\S]*?setPreview\(data\);/,
  "workflow start loadPreview should normalize preview before state updates",
);

assert.match(
  page,
  /setResult\(normalizeLaunchResult\(parsed\)\);/,
  "workflow start launch should normalize launch result before rendering run links",
);

console.log("workflow start response normalization contract tests passed");
