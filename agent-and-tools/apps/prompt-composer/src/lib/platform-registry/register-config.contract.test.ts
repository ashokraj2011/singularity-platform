import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/platform-registry/register.ts", "utf8");
const packageSource = readFileSync("package.json", "utf8");

assert.match(source, /function boundedSeconds\(raw: unknown, defaultValue: number, min: number, max: number\)/);
assert.match(source, /PLATFORM_REGISTRY_REGISTER_TIMEOUT_SEC/);
assert.match(source, /PLATFORM_REGISTRY_HEARTBEAT_TIMEOUT_SEC/);
assert.match(source, /const REGISTER_TIMEOUT_MS = boundedSeconds\(process\.env\.PLATFORM_REGISTRY_REGISTER_TIMEOUT_SEC, 5, 1, 300\) \* 1000/);
assert.match(source, /const HEARTBEAT_TIMEOUT_MS = boundedSeconds\(process\.env\.PLATFORM_REGISTRY_HEARTBEAT_TIMEOUT_SEC, 3, 1, 300\) \* 1000/);
assert.match(source, /AbortSignal\.timeout\(REGISTER_TIMEOUT_MS\)/);
assert.match(source, /AbortSignal\.timeout\(HEARTBEAT_TIMEOUT_MS\)/);
assert.doesNotMatch(source, /AbortSignal\.timeout\((?:5000|3000)\)/);
assert.match(packageSource, /lib\/platform-registry\/register-config\.contract\.test\.ts/);

console.log("prompt-composer platform-registry config contract tests passed");
