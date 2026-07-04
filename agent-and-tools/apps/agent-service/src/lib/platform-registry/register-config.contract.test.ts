import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageSource = readFileSync("package.json", "utf8");

for (const file of [
  "src/lib/platform-registry/register.ts",
  "src/tool/lib/platform-registry/register.ts",
]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /function boundedSeconds\(raw: unknown, defaultValue: number, min: number, max: number\)/, `${file} must use bounded timeout parsing`);
  assert.match(source, /PLATFORM_REGISTRY_REGISTER_TIMEOUT_SEC/, `${file} must expose register timeout env`);
  assert.match(source, /PLATFORM_REGISTRY_HEARTBEAT_TIMEOUT_SEC/, `${file} must expose heartbeat timeout env`);
  assert.match(source, /const REGISTER_TIMEOUT_MS = boundedSeconds\(process\.env\.PLATFORM_REGISTRY_REGISTER_TIMEOUT_SEC, 5, 1, 300\) \* 1000/, `${file} register timeout bounds changed`);
  assert.match(source, /const HEARTBEAT_TIMEOUT_MS = boundedSeconds\(process\.env\.PLATFORM_REGISTRY_HEARTBEAT_TIMEOUT_SEC, 3, 1, 300\) \* 1000/, `${file} heartbeat timeout bounds changed`);
  assert.match(source, /AbortSignal\.timeout\(REGISTER_TIMEOUT_MS\)/, `${file} register fetch must use bounded timeout`);
  assert.match(source, /AbortSignal\.timeout\(HEARTBEAT_TIMEOUT_MS\)/, `${file} heartbeat fetch must use bounded timeout`);
  assert.doesNotMatch(source, /AbortSignal\.timeout\((?:5000|3000)\)/, `${file} must not hardcode registry timeouts`);
}

assert.match(packageSource, /lib\/platform-registry\/register-config\.contract\.test\.ts/);

console.log("agent-service platform-registry config contract tests passed");
