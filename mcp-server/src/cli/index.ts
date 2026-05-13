#!/usr/bin/env node
/**
 * M26 — singularity-mcp CLI.
 *
 *   singularity-mcp login   --email <e> [--platform <url>] [--device-name <n>]
 *   singularity-mcp start                # connect with the saved device token
 *   singularity-mcp status               # show login + connection state
 *   singularity-mcp doctor               # diagnose environment
 *   singularity-mcp logout               # delete the saved token
 *
 * Token storage (v0): a JSON file at $SINGULARITY_MCP_HOME (default
 * ~/.singularity-mcp/token.json) with 0600 permissions. M26.5 will swap
 * this for the OS keychain via `keytar`.
 *
 * For demo / dev: --platform defaults to http://localhost:8101 (pseudo-IAM
 * for token mint) and the bridge is ws://localhost:8000/api/laptop-bridge/connect
 * (context-fabric). Override with --platform / --bridge / env.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const HOME           = process.env.SINGULARITY_MCP_HOME ?? join(homedir(), ".singularity-mcp");
const TOKEN_FILE     = join(HOME, "token.json");
const DEFAULT_IAM    = process.env.SINGULARITY_IAM_URL    ?? "http://localhost:8101/api/v1";
const DEFAULT_BRIDGE = process.env.LAPTOP_BRIDGE_URL      ?? "ws://localhost:8000/api/laptop-bridge/connect";

interface SavedToken {
  access_token:    string;
  device_id:       string;
  device_name:     string;
  email:           string;
  user_id:         string;
  expires_in_days: number;
  saved_at:        string;
}

function ensureHome(): void {
  if (!existsSync(HOME)) {
    mkdirSync(HOME, { recursive: true });
    chmodSync(HOME, 0o700);
  }
}

function saveToken(t: SavedToken): void {
  ensureHome();
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

function loadToken(): SavedToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as SavedToken;
  } catch {
    return null;
  }
}

function parseArgs(): { cmd: string; flags: Record<string, string> } {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      flags[key] = val;
    }
  }
  return { cmd, flags };
}

// ─── login ──────────────────────────────────────────────────────────────────
async function cmdLogin(flags: Record<string, string>): Promise<void> {
  const platform   = flags["platform"]    ?? DEFAULT_IAM;
  const email      = flags["email"]       ?? `${process.env.USER ?? "dev"}@laptop.local`;
  const deviceName = flags["device-name"] ?? `${process.env.USER ?? "dev"}-${process.platform}`;
  const password   = flags["password"]    ?? "anything";       // pseudo-iam accepts anything
  const ttlDays    = Number(flags["ttl-days"] ?? 90);

  console.log(`▸ login: platform=${platform} email=${email} device=${deviceName} ttl=${ttlDays}d`);

  // Step 1 — mint a user JWT via pseudo-IAM /auth/local/login.
  const loginRes = await fetch(`${platform.replace(/\/$/, "")}/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    console.error(`✗ /auth/local/login failed: ${loginRes.status} ${await loginRes.text()}`);
    process.exit(1);
  }
  const loginBody = await loginRes.json() as { access_token: string };

  // Step 2 — exchange the user JWT for a 90-day device token.
  const deviceId = loadToken()?.device_id ?? randomUUID();
  const deviceRes = await fetch(`${platform.replace(/\/$/, "")}/auth/device-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${loginBody.access_token}` },
    body: JSON.stringify({ device_id: deviceId, device_name: deviceName, ttl_days: ttlDays, scopes: [] }),
  });
  if (!deviceRes.ok) {
    console.error(`✗ /auth/device-token failed: ${deviceRes.status} ${await deviceRes.text()}`);
    process.exit(1);
  }
  const dt = await deviceRes.json() as {
    access_token: string; device_id: string; user_id: string;
    email: string; device_name: string; expires_in_days: number;
  };

  saveToken({
    access_token:    dt.access_token,
    device_id:       dt.device_id,
    device_name:     dt.device_name,
    email:           dt.email,
    user_id:         dt.user_id,
    expires_in_days: dt.expires_in_days,
    saved_at:        new Date().toISOString(),
  });
  console.log(`✓ saved device token to ${TOKEN_FILE} (user_id=${dt.user_id}, device_id=${dt.device_id})`);
  console.log(`  Next: singularity-mcp start`);
}

// ─── start ──────────────────────────────────────────────────────────────────
function cmdStart(flags: Record<string, string>): void {
  const tok = loadToken();
  if (!tok) {
    console.error("✗ no saved token. Run `singularity-mcp login` first.");
    process.exit(1);
  }
  const bridgeUrl = flags["bridge"] ?? DEFAULT_BRIDGE;
  // Re-exec mcp-server in laptop mode with the saved token in the env.
  // The CLI script lives at dist/cli/index.js; mcp-server's entry is
  // dist/index.js. Resolve relative to this file.
  const here = __dirname.includes("/dist/") ? __dirname : __dirname.replace(/src\/cli$/, "dist/cli");
  const entry = join(dirname(dirname(here)), "index.js");

  if (!existsSync(entry)) {
    // Dev-mode fallback: run via ts-node-dev against src/.
    console.error(`✗ compiled entry not found at ${entry}.`);
    console.error(`  Build the server: cd mcp-server && npm run build`);
    process.exit(1);
  }

  console.log(`▸ starting mcp-server (laptop mode) → bridge=${bridgeUrl}`);
  console.log(`  user_id=${tok.user_id} device=${tok.device_name}`);

  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: {
      ...process.env,
      LAPTOP_MODE: "true",
      LAPTOP_BRIDGE_URL: bridgeUrl,
      SINGULARITY_DEVICE_TOKEN: tok.access_token,
      SINGULARITY_DEVICE_ID:    tok.device_id,
      SINGULARITY_DEVICE_NAME:  tok.device_name,
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ─── status ─────────────────────────────────────────────────────────────────
function cmdStatus(): void {
  const tok = loadToken();
  if (!tok) {
    console.log("● not logged in.  Run: singularity-mcp login");
    return;
  }
  const saved = new Date(tok.saved_at);
  const expires = new Date(saved.getTime() + tok.expires_in_days * 86400_000);
  const days = Math.round((expires.getTime() - Date.now()) / 86400_000);
  console.log(`● logged in as ${tok.email} (user_id=${tok.user_id})`);
  console.log(`  device:        ${tok.device_name} (${tok.device_id})`);
  console.log(`  token expires: ${expires.toISOString()}  (~${days}d remaining)`);
  console.log(`  token file:    ${TOKEN_FILE}`);
}

// ─── doctor ─────────────────────────────────────────────────────────────────
function check(label: string, fn: () => string): { label: string; ok: boolean; msg: string } {
  try {
    const msg = fn();
    return { label, ok: true, msg };
  } catch (err) {
    return { label, ok: false, msg: (err as Error).message };
  }
}

function cmdDoctor(): void {
  const checks = [
    check("node version", () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (major < 18) throw new Error(`need ≥ 18, have ${process.versions.node}`);
      return process.versions.node;
    }),
    check("token saved",  () => {
      const tok = loadToken();
      if (!tok) throw new Error("no token saved — run `singularity-mcp login`");
      return `${tok.email} (${tok.device_name})`;
    }),
    check("token file permissions", () => {
      if (!existsSync(TOKEN_FILE)) throw new Error("no token");
      const mode = statSync(TOKEN_FILE).mode & 0o777;
      if (mode !== 0o600) throw new Error(`mode ${mode.toString(8)} (expected 600)`);
      return "0600";
    }),
    check("gh cli installed", () => {
      const r = spawnSyncCheck("gh", ["--version"]);
      return r.stdout.split("\n")[0];
    }),
    check("gh authenticated", () => {
      spawnSyncCheck("gh", ["auth", "status"]);
      return "ok";
    }),
    check("gh copilot extension", () => {
      const r = spawnSyncCheck("gh", ["extension", "list"]);
      if (!/copilot/i.test(r.stdout)) throw new Error("install via `gh extension install github/gh-copilot`");
      return "installed";
    }),
    check("git installed", () => spawnSyncCheck("git", ["--version"]).stdout.trim()),
  ];

  console.log("singularity-mcp doctor");
  console.log("──────────────────────");
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    console.log(`  ${icon} ${c.label.padEnd(28)} ${c.msg}`);
  }
  const fail = checks.filter(c => !c.ok).length;
  console.log("");
  if (fail === 0) console.log("✓ all good.");
  else            { console.log(`✗ ${fail} check(s) failed.`); process.exit(1); }
}

function spawnSyncCheck(bin: string, args: string[]): { stdout: string; stderr: string } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const res = spawnSync(bin, args, { encoding: "utf8" });
  if (res.error)    throw res.error;
  if (res.status !== 0) throw new Error(res.stderr || `${bin} exited with ${res.status}`);
  return { stdout: res.stdout, stderr: res.stderr };
}

// ─── logout ─────────────────────────────────────────────────────────────────
function cmdLogout(): void {
  if (existsSync(TOKEN_FILE)) {
    unlinkSync(TOKEN_FILE);
    console.log(`✓ deleted ${TOKEN_FILE}`);
  } else {
    console.log("● nothing to remove.");
  }
}

// ─── dispatch ───────────────────────────────────────────────────────────────
function usage(): void {
  console.log(`singularity-mcp — laptop-resident MCP server for Singularity.

Commands:
  login   --email <e> [--platform <url>] [--device-name <n>] [--ttl-days N]
          Mint a 90-day device token and save it to ${TOKEN_FILE}.

  start   [--bridge <wss://…>]
          Boot mcp-server in laptop mode using the saved token.

  status  Show login state.
  doctor  Diagnose environment (gh cli, copilot extension, git, perms).
  logout  Delete the saved token.

Defaults: --platform ${DEFAULT_IAM}
          --bridge   ${DEFAULT_BRIDGE}
`);
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs();
  switch (cmd) {
    case "login":  await cmdLogin(flags); break;
    case "start":  cmdStart(flags); break;
    case "status": cmdStatus(); break;
    case "doctor": cmdDoctor(); break;
    case "logout": cmdLogout(); break;
    case "help": case "--help": case "-h": case undefined: usage(); break;
    default: console.error(`unknown command: ${cmd}\n`); usage(); process.exit(1);
  }
}

void main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
