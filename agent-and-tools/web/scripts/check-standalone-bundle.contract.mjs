#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve("scripts/check-standalone-bundle.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-web-standalone-contract-"));
}

function writeFile(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createBundle(root, options = {}) {
  const appRoot = options.nested ? path.join(root, "web") : root;
  writeFile(path.join(appRoot, "server.js"), "console.log('platform-web');\n");
  writeFile(path.join(appRoot, ".next/server/webpack-runtime.js"), options.runtime ?? "require('./chunks/1.js');\n");
  writeFile(path.join(appRoot, ".next/server/chunks/1.js"), "module.exports = {};\n");
  if (options.static !== false) {
    writeFile(path.join(appRoot, ".next/static/build-id/app.js"), "console.log('static');\n");
  }
  return appRoot;
}

function run(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    if (options.expectFailure) {
      return {
        ok: false,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? ""),
      };
    }
    throw err;
  }
}

{
  const root = makeTempDir();
  const appRoot = createBundle(root);
  const result = run([root, "--print-root"]);
  assert.equal(result.stdout.trim(), appRoot, "checker should accept root standalone layout");
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeTempDir();
  const appRoot = createBundle(root, { nested: true });
  const result = run([root, "--print-root"]);
  assert.equal(result.stdout.trim(), appRoot, "checker should discover monorepo web/ standalone layout");
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeTempDir();
  createBundle(root, { runtime: "require('./chunks/missing.js');\n" });
  const result = run([root], { expectFailure: true });
  assert.equal(result.ok, false, "checker should fail when a compiled server chunk reference is missing");
  assert.match(result.stderr, /webpack-runtime\.js -> \.\/chunks\/missing\.js/);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeTempDir();
  createBundle(root, { static: false });
  const failed = run([root], { expectFailure: true });
  assert.equal(failed.ok, false, "checker should fail when static assets were not copied");
  assert.match(failed.stderr, /\.next\/static\/\*/);
  const skipped = run([root, "--skip-static", "--print-root"]);
  assert.equal(skipped.stdout.trim(), root, "checker should allow explicit static skip for local source-layout checks");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("standalone bundle checker contract tests passed");
