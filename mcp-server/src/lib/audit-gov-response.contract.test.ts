import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const check = readFileSync(path.resolve(process.cwd(), "src/lib/audit-gov-check.ts"), "utf8");
const approvals = readFileSync(path.resolve(process.cwd(), "src/lib/audit-gov-approvals.ts"), "utf8");

assert.match(
  check,
  /async function readAuditGovCheckJson<T>\(res: Response, path: string\): Promise<T \| null>/,
  "audit-governance checks should centralize response parsing",
);

assert.match(
  check,
  /returned invalid JSON/,
  "audit-governance checks should log malformed successful responses",
);

assert.match(
  check,
  /return readAuditGovCheckJson<T>\(res, path\)/,
  "budget/rate-limit checks should use guarded response parsing",
);

assert.doesNotMatch(
  check,
  /res\.json\(\)/,
  "audit-governance checks should not call res.json() directly",
);

assert.match(
  approvals,
  /async function readConsumedApprovalBody\(res: Response, continuationToken: string\)/,
  "approval consume should centralize response parsing",
);

assert.match(
  approvals,
  /returned invalid JSON/,
  "approval consume should log malformed successful responses",
);

assert.match(
  approvals,
  /const body = await readConsumedApprovalBody\(res, continuationToken\);[\s\S]*?if \(!body \|\| typeof body\.id !== "string"/,
  "approval consume should validate required response fields before resuming",
);

assert.doesNotMatch(
  approvals,
  /res\.json\(\)/,
  "approval consume should not call res.json() directly",
);

console.log("mcp audit-governance response contract tests passed");
