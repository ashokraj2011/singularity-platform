import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const check = readFileSync(path.resolve(process.cwd(), "src/lib/audit-gov-check.ts"), "utf8");
const approvals = readFileSync(path.resolve(process.cwd(), "src/lib/audit-gov-approvals.ts"), "utf8");
const emit = readFileSync(path.resolve(process.cwd(), "src/lib/audit-gov-emit.ts"), "utf8");

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

assert.match(
  check,
  /const AUDIT_GOV_CHECK_TIMEOUT_MS = config\.MCP_AUDIT_GOV_CHECK_TIMEOUT_MS;/,
  "audit-governance checks should use bounded MCP timeout config",
);

assert.match(
  check,
  /AbortSignal\.timeout\(AUDIT_GOV_CHECK_TIMEOUT_MS\)/,
  "audit-governance checks should use the shared check timeout constant",
);

assert.doesNotMatch(
  check,
  /const TIMEOUT_MS\s*=\s*3_000|AbortSignal\.timeout\(TIMEOUT_MS\)/,
  "audit-governance checks should not hardcode milliseconds",
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

assert.match(
  approvals,
  /const AUDIT_GOV_APPROVAL_TIMEOUT_MS = config\.MCP_AUDIT_GOV_APPROVAL_TIMEOUT_MS;/,
  "approval persistence should use bounded MCP timeout config",
);

assert.match(
  approvals,
  /AbortSignal\.timeout\(AUDIT_GOV_APPROVAL_TIMEOUT_MS\)/,
  "approval persistence and consume should use the shared approval timeout constant",
);

assert.doesNotMatch(
  approvals,
  /const TIMEOUT_MS\s*=\s*5_000|AbortSignal\.timeout\(TIMEOUT_MS\)/,
  "approval persistence should not hardcode milliseconds",
);

assert.doesNotMatch(
  approvals,
  /res\.json\(\)/,
  "approval consume should not call res.json() directly",
);

assert.match(
  emit,
  /const AUDIT_GOV_EMIT_TIMEOUT_MS = config\.MCP_AUDIT_GOV_EMIT_TIMEOUT_MS;/,
  "audit event emission should use bounded MCP timeout config",
);

assert.match(
  emit,
  /AbortSignal\.timeout\(AUDIT_GOV_EMIT_TIMEOUT_MS\)/,
  "audit event emission should use the shared emit timeout constant",
);

assert.doesNotMatch(
  emit,
  /const TIMEOUT_MS\s*=\s*5_000|AbortSignal\.timeout\(TIMEOUT_MS\)/,
  "audit event emission should not hardcode milliseconds",
);

console.log("mcp audit-governance response contract tests passed");
