import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boundedSecondsEnv } from "./serverEnvBounds";

const originalEnv = { ...process.env };

try {
  delete process.env.TEST_SERVER_TIMEOUT_SEC;
  assert.equal(boundedSecondsEnv("TEST_SERVER_TIMEOUT_SEC", 5, 1, 300), 5);

  process.env.TEST_SERVER_TIMEOUT_SEC = "";
  assert.equal(boundedSecondsEnv("TEST_SERVER_TIMEOUT_SEC", 5, 1, 300), 5);

  process.env.TEST_SERVER_TIMEOUT_SEC = "bad";
  assert.equal(boundedSecondsEnv("TEST_SERVER_TIMEOUT_SEC", 5, 1, 300), 5);

  process.env.TEST_SERVER_TIMEOUT_SEC = "0";
  assert.equal(boundedSecondsEnv("TEST_SERVER_TIMEOUT_SEC", 5, 1, 300), 5);

  process.env.TEST_SERVER_TIMEOUT_SEC = "12.9";
  assert.equal(boundedSecondsEnv("TEST_SERVER_TIMEOUT_SEC", 5, 1, 300), 12);

  process.env.TEST_SERVER_TIMEOUT_SEC = "9999";
  assert.equal(boundedSecondsEnv("TEST_SERVER_TIMEOUT_SEC", 5, 1, 300), 300);
} finally {
  process.env = originalEnv;
}

const source = fs.readFileSync(path.join(process.cwd(), "src/lib/serverEnvBounds.ts"), "utf8");
const pkg = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");

assert.match(source, /import \{ serverEnv \} from "\.\/serverRootEnv";/);
assert.match(source, /export function boundedSecondsEnv\(name: string, defaultValue: number, min: number, max: number\): number/);
assert.match(source, /Number\(raw\.trim\(\)\)/);
assert.match(source, /Math\.min\(max, Math\.trunc\(value\)\)/);
assert.match(pkg, /server-env-bounds\.contract\.test\.ts/);

console.log("server env bounds contract tests passed");
