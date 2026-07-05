#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.SINGULARITY_WEB_NEXT_CACHE_ROOT
  ? path.resolve(process.env.SINGULARITY_WEB_NEXT_CACHE_ROOT)
  : path.resolve(scriptDir, "..");
const nextDir = path.join(appRoot, ".next");

if (process.env.SINGULARITY_WEB_SKIP_CLEAN_NEXT === "1") {
  console.log("platform-web Next cache clean skipped by SINGULARITY_WEB_SKIP_CLEAN_NEXT=1");
  process.exit(0);
}

if (process.env.SINGULARITY_WEB_FORCE_CLEAN_NEXT !== "1") {
  const running = runningNextServers(appRoot);
  if (running.length > 0) {
    console.error("platform-web Next cache clean refused because a repo-owned Next server is running.");
    for (const server of running) {
      console.error(`  pid ${server.pid} on :${server.port} (${server.cwd || "cwd unknown"})`);
    }
    console.error("Stop platform-web first, or set SINGULARITY_WEB_FORCE_CLEAN_NEXT=1 only when you accept live asset 404s.");
    process.exit(1);
  }
}

fs.rmSync(nextDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(`platform-web Next dev cache cleared: ${path.relative(appRoot, nextDir) || ".next"}`);

function runningNextServers(root) {
  if (!hasCommand("lsof")) return [];
  const ports = Array.from(new Set([process.env.PORT || "3000", "5180"]));
  const servers = [];
  for (const port of ports) {
    const pids = commandOutput("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    for (const pid of pids) {
      const cwd = commandOutput("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])
        .split(/\r?\n/)
        .find((line) => line.startsWith("n"))
        ?.slice(1) ?? "";
      const command = commandOutput("ps", ["-p", pid, "-o", "command="]);
      if (isUnderRoot(cwd, root) || command.includes(root)) {
        servers.push({ pid, port, cwd });
      }
    }
  }
  return servers;
}

function isUnderRoot(candidate, root) {
  if (!candidate) return false;
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function hasCommand(command) {
  return commandOutput("sh", ["-c", `command -v ${command}`]) !== "";
}
