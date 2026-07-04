import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/tools/page.tsx"), "utf8");

assert.match(
  source,
  /function parseJsonObjectField\(label: string, raw: string, optional = false\): Record<string, unknown> \| undefined[\s\S]*?JSON\.parse\(text\) as unknown[\s\S]*?Array\.isArray\(parsed\)[\s\S]*?must be a JSON object/,
  "tool registration should parse user JSON fields safely and require object-shaped schemas/runtime config",
);

assert.match(
  source,
  /inputSchema = parseJsonObjectField\("Input schema", form\.input_schema\)[\s\S]*?outputSchema = parseJsonObjectField\("Output schema", form\.output_schema, true\)[\s\S]*?setWizardStep\(1\)/,
  "invalid input/output schema JSON should return the wizard to the Contract step",
);

assert.match(
  source,
  /runtime = parseJsonObjectField\("Runtime", form\.runtime\)[\s\S]*?setWizardStep\(2\)/,
  "invalid runtime JSON should return the wizard to the Runtime step",
);

assert.match(
  source,
  /allowed_capabilities: commaList\(form\.allowed_capabilities\)[\s\S]*?allowed_agents: commaList\(form\.allowed_agents\)[\s\S]*?tags: commaList\(form\.tags\)/,
  "comma-separated scope/tag fields should be normalized before submission",
);

assert.doesNotMatch(
  source,
  /JSON\.parse\(form\.(input_schema|runtime|output_schema)\)/,
  "tool registration should not directly parse form JSON inside the API payload",
);

console.log("tool registration JSON validation contract tests passed");
