#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const printRoot = args.includes("--print-root");
const skipStatic = args.includes("--skip-static");
const rootArg = args.find(arg => !arg.startsWith("--")) ?? process.cwd();
const root = path.resolve(rootArg);

function unique(values) {
  return Array.from(new Set(values));
}

function candidateRoots(base) {
  return unique([
    base,
    path.join(base, "web"),
    path.join(base, "agent-and-tools", "web"),
    path.join(base, "apps", "web"),
  ]);
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith(".js")) out.push(full);
  }
  return out;
}

function hasAnyFile(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasAnyFile(full)) return true;
  }
  return false;
}

const checked = [];
let appRoot = null;
for (const candidate of candidateRoots(root)) {
  checked.push(candidate);
  if (
    fs.existsSync(path.join(candidate, "server.js"))
    && fs.existsSync(path.join(candidate, ".next", "server", "webpack-runtime.js"))
  ) {
    appRoot = candidate;
    break;
  }
}

if (!appRoot) {
  console.error("FATAL: platform-web standalone bundle is incomplete.");
  console.error("Expected server.js and .next/server/webpack-runtime.js under one of:");
  for (const candidate of checked) console.error(`  ${candidate}`);
  console.error("Fix: rebuild platform-web from a clean workspace/image cache, then restart the container.");
  process.exit(1);
}

const serverRoot = path.join(appRoot, ".next", "server");
const missing = [];

for (const file of walk(serverRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const requires = source.matchAll(/require\((["'])(\.{1,2}\/[^"']+\.js)\1\)/g);
  for (const match of requires) {
    const target = path.resolve(path.dirname(file), match[2]);
    if (!fs.existsSync(target)) {
      missing.push(`${path.relative(appRoot, file)} -> ${match[2]}`);
    }
  }
}

const chunkDir = path.join(serverRoot, "chunks");
if (!fs.existsSync(chunkDir) || !fs.readdirSync(chunkDir).some(name => name.endsWith(".js"))) {
  missing.push(".next/server/chunks/*.js");
}

const staticDir = path.join(appRoot, ".next", "static");
if (!skipStatic && !hasAnyFile(staticDir)) {
  missing.push(".next/static/*");
}

if (missing.length) {
  console.error("FATAL: platform-web standalone bundle is missing compiled server chunks or static assets.");
  console.error("This usually means a stale or partial Next build was copied into the image.");
  console.error("Fix: rebuild platform-web from a clean workspace/image cache, then restart the container.");
  for (const item of missing.slice(0, 25)) console.error(`  missing ${item}`);
  if (missing.length > 25) console.error(`  ...and ${missing.length - 25} more`);
  process.exit(1);
}

if (printRoot) {
  console.log(appRoot);
} else {
  console.log(`OK platform-web standalone bundle verified at ${appRoot}`);
}
