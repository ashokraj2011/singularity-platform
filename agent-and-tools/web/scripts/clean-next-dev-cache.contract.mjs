#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts/clean-next-dev-cache.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

assert.match(
  pkg.scripts.dev,
  /node scripts\/clean-next-dev-cache\.mjs && next dev/,
  "platform-web dev script should clear stale Next chunks before starting Next dev",
);

assert.match(
  pkg.scripts.build,
  /node scripts\/clean-next-dev-cache\.mjs && next build/,
  "platform-web build script should clear stale Next chunks before creating a standalone bundle",
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-web-next-cache-"));
const nextServerDir = path.join(tempRoot, ".next/server/vendor-chunks");
fs.mkdirSync(nextServerDir, { recursive: true });
fs.writeFileSync(path.join(nextServerDir, "@opentelemetry.js"), "module.exports = {};\n");

const clean = spawnSync(process.execPath, [script], {
  cwd: repoRoot,
  env: { ...process.env, SINGULARITY_WEB_NEXT_CACHE_ROOT: tempRoot },
  encoding: "utf8",
});
assert.equal(clean.status, 0, clean.stderr);
assert.equal(fs.existsSync(path.join(tempRoot, ".next")), false, "cleaner should remove stale .next output");

fs.mkdirSync(path.join(tempRoot, ".next/server"), { recursive: true });
const keepFile = path.join(tempRoot, ".next/server/webpack-runtime.js");
fs.writeFileSync(keepFile, "module.exports = {};\n");
const skipped = spawnSync(process.execPath, [script], {
  cwd: repoRoot,
  env: {
    ...process.env,
    SINGULARITY_WEB_NEXT_CACHE_ROOT: tempRoot,
    SINGULARITY_WEB_SKIP_CLEAN_NEXT: "1",
  },
  encoding: "utf8",
});
assert.equal(skipped.status, 0, skipped.stderr);
assert.equal(fs.existsSync(keepFile), true, "skip env should leave .next intact for advanced debugging");

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("platform-web Next dev cache cleaner contract tests passed");
