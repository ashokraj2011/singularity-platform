import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/tool-grants/page.tsx"), "utf8");

assert.match(
  source,
  /function parseToolInput\(raw: string\): Record<string, unknown>[\s\S]*?JSON\.parse\(text\) as unknown[\s\S]*?Array\.isArray\(parsed\)[\s\S]*?Tool input must be a JSON object/,
  "Tool Grants validation should parse user JSON safely and require object-shaped tool input",
);

assert.match(
  source,
  /setValidateError\(null\);[\s\S]*?setValidateResult\(null\);[\s\S]*?Tool name is required before validation[\s\S]*?input: parseToolInput\(validateForm\.input\)/,
  "Tool Grants validation should clear stale results and reject missing tool/input errors before calling the API",
);

assert.match(
  source,
  /catch \(err\) \{[\s\S]*?setValidateError\(err instanceof Error \? err\.message : "Validation failed\."\);[\s\S]*?finally \{[\s\S]*?setValidateBusy\(false\);/,
  "Tool Grants validation should render API and parse failures inline",
);

assert.match(
  source,
  /role="alert"[\s\S]*?\{validateError\}[\s\S]*?disabled=\{validateBusy\}/,
  "Tool Grants validation errors should be visible and validation should disable while busy",
);

assert.doesNotMatch(
  source,
  /catch \{ parsed = \{\}; \}/,
  "Tool Grants validation should not silently replace invalid JSON with an empty object",
);

console.log("tool grants JSON validation contract tests passed");
