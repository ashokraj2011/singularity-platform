import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.resolve(process.cwd(), "src/tools/learning.ts"), "utf8");

assert.match(
  source,
  /async function readLearningJson\(res: Response, path: string\): Promise<unknown>/,
  "learning tools should centralize learning-service response parsing",
);

assert.match(
  source,
  /learning-service \$\{path\} returned invalid JSON/,
  "learning tools should surface malformed learning-service success bodies as unavailable details",
);

assert.match(
  source,
  /return readLearningJson\(res, path\)/,
  "learningFetch should use guarded response parsing",
);

assert.doesNotMatch(
  source,
  /return res\.json\(\)/,
  "learningFetch should not call res.json() directly",
);

console.log("mcp learning response contract tests passed");
