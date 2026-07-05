import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const emitterSource = readFileSync(path.resolve(__dirname, "audit-gov-emit.ts"), "utf8");
const envSource = readFileSync("src/config/env.ts", "utf8");

assert.match(
  envSource,
  /AUDIT_GOV_EMIT_TIMEOUT_SEC: boundedInt\(5, 1, 300\)/,
  "audit-governance emit timeout must be bounded in prompt-composer env config",
);

assert.match(
  emitterSource,
  /import \{ env \} from "\.\.\/config\/env";/,
  "audit-governance emitter should read timeout config from prompt-composer env",
);

assert.match(
  emitterSource,
  /const AUDIT_GOV_EMIT_TIMEOUT_MS = env\.AUDIT_GOV_EMIT_TIMEOUT_SEC \* 1000;/,
  "audit-governance emitter timeout must come from bounded env config",
);

assert.match(
  emitterSource,
  /AbortSignal\.timeout\(AUDIT_GOV_EMIT_TIMEOUT_MS\)/,
  "audit-governance emitter fetch must use the bounded timeout constant",
);

assert.doesNotMatch(
  emitterSource,
  /const TIMEOUT_MS\s*=\s*5_000|AbortSignal\.timeout\((?:5_000|5000)\)/,
  "audit-governance emitter must not hardcode its network timeout",
);

console.log("prompt-composer audit-governance emit contract tests passed");
