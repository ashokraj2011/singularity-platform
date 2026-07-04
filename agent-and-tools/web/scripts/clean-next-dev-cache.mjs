#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.SINGULARITY_WEB_NEXT_CACHE_ROOT
  ? path.resolve(process.env.SINGULARITY_WEB_NEXT_CACHE_ROOT)
  : path.resolve(scriptDir, "..");
const nextDir = path.join(appRoot, ".next");

if (process.env.SINGULARITY_WEB_SKIP_CLEAN_NEXT === "1") {
  console.log("platform-web Next cache clean skipped by SINGULARITY_WEB_SKIP_CLEAN_NEXT=1");
  process.exit(0);
}

fs.rmSync(nextDir, { recursive: true, force: true });
console.log(`platform-web Next dev cache cleared: ${path.relative(appRoot, nextDir) || ".next"}`);
