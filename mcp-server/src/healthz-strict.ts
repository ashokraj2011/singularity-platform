/**
 * M28 boot-1 — strict health invariants for mcp-server.
 *
 * Why this exists: `/health` only confirms the HTTP listener responds. It
 * doesn't confirm the sandbox exists, the LLM provider key resolves a real
 * model, or that `git` is on PATH. That's why a misconfigured mcp-server
 * silently failed for 11 hours in demo prep (cwd=/workspace ENOENT was masked
 * as "spawn git").
 *
 * `/healthz/strict` asserts every declared invariant in parallel and returns
 * 200 only if all pass. Used by:
 *   1. bin/demo-up.sh — boot-time gate before declaring the demo ready
 *   2. CI compose smoke — catches misconfig regressions on every PR
 *   3. Operators — first-line diagnostic when something feels off
 *
 * Each check is small + cheap. The whole endpoint completes in < 500ms.
 */
import { existsSync, statSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { config } from "./config";
import { configuredDefaultProvider } from "./llm/provider-config";
import { listConfiguredProviders } from "./llm/client";

export interface InvariantResult {
  name: string;
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

type InvariantCheck = () => Promise<InvariantResult> | InvariantResult;

const checks: InvariantCheck[] = [
  // 1. Sandbox root exists, is a directory, and is writable.
  () => {
    const path = config.MCP_SANDBOX_ROOT;
    if (!existsSync(path)) return { name: "sandbox_root_exists", ok: false, reason: `MCP_SANDBOX_ROOT=${path} does not exist`, details: { path } };
    const stat = statSync(path);
    if (!stat.isDirectory()) return { name: "sandbox_root_exists", ok: false, reason: `${path} is not a directory`, details: { path } };
    try { accessSync(path, constants.W_OK); }
    catch { return { name: "sandbox_root_exists", ok: false, reason: `${path} is not writable`, details: { path } }; }
    return { name: "sandbox_root_exists", ok: true, details: { path } };
  },

  // 2. Sandbox root is a git working tree. Branch operations need it.
  () => {
    const path = config.MCP_SANDBOX_ROOT;
    const gitDir = `${path}/.git`;
    if (!existsSync(gitDir)) return { name: "sandbox_is_git_repo", ok: false, reason: `${gitDir} not found — sandbox must be a git working tree`, details: { path } };
    return { name: "sandbox_is_git_repo", ok: true };
  },

  // 3. `git` binary resolves on PATH (catches the "spawn git ENOENT" masquerade).
  () => {
    try {
      const v = execFileSync("git", ["--version"], { encoding: "utf8", timeout: 2000 }).trim();
      return { name: "git_on_path", ok: true, details: { version: v } };
    } catch (err) {
      return { name: "git_on_path", ok: false, reason: `git not on PATH: ${(err as Error).message}` };
    }
  },

  // 4. LLM gateway is reachable + the default provider is ready according to it.
  async () => {
    const url = config.LLM_GATEWAY_URL?.trim();
    if (!url) return { name: "llm_gateway_reachable", ok: false, reason: "LLM_GATEWAY_URL is not set" };
    if (url === "mock") return { name: "llm_gateway_reachable", ok: true, details: { mode: "in-process-mock" } };
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) {
        return { name: "llm_gateway_reachable", ok: false, reason: `LLM gateway /health returned ${res.status}`, details: { url } };
      }
      return { name: "llm_gateway_reachable", ok: true, details: { url } };
    } catch (err) {
      return { name: "llm_gateway_reachable", ok: false, reason: `LLM gateway unreachable: ${(err as Error).message}`, details: { url } };
    }
  },

  // 4b. The default provider must be ready according to the gateway. Falls
  // back to "mock-only" if the gateway can't be probed (the request above
  // would have already failed in that case).
  async () => {
    // refreshGatewayProviderStatus is called via lazy import to avoid a
    // boot-time circular dependency through ./llm/client.
    const { refreshGatewayProviderStatus } = await import("./llm/client");
    await refreshGatewayProviderStatus();
    const provider = configuredDefaultProvider();
    const info = listConfiguredProviders().find((p) => p.name === provider);
    if (info?.ready) return { name: "llm_default_provider_ready", ok: true, details: { provider } };
    return {
      name: "llm_default_provider_ready",
      ok: false,
      reason: `Default provider ${provider} is not ready on the gateway`,
      details: { provider, warnings: info?.warnings ?? [] },
    };
  },

  // 4c. No forbidden provider keys leaked into this process's env. Reading
  // a key here means the gateway lockdown was bypassed.
  () => {
    const forbidden = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "COPILOT_TOKEN", "GOOGLE_API_KEY", "COHERE_API_KEY"];
    const leaked = forbidden.filter((k) => Boolean(process.env[k]));
    if (leaked.length === 0) return { name: "no_forbidden_provider_keys", ok: true };
    return {
      name: "no_forbidden_provider_keys",
      ok: false,
      reason: "Provider keys leaked into mcp-server env. Only llm-gateway-service may read these.",
      details: { leaked },
    };
  },

  // 5. MCP bearer token is non-default-empty + meets the > 16 char floor.
  () => {
    const t = config.MCP_BEARER_TOKEN;
    if (!t || t.length < 16) return { name: "bearer_token_set", ok: false, reason: "MCP_BEARER_TOKEN missing or shorter than 16 chars" };
    return { name: "bearer_token_set", ok: true };
  },

  // 6. AST DB path's directory is writable (else AST index fails on first invoke).
  () => {
    const dbPath = config.MCP_AST_DB_PATH;
    if (!dbPath) return { name: "ast_db_dir_writable", ok: true, details: { note: "MCP_AST_DB_PATH unset — index will not persist" } };
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (!dir) return { name: "ast_db_dir_writable", ok: true, details: { note: "AST DB at fs root" } };
    if (!existsSync(dir)) {
      // We can attempt to create it on first index; surface as a warning not a fail.
      return { name: "ast_db_dir_writable", ok: true, details: { dir, note: "directory missing — will be created on first index" } };
    }
    try { accessSync(dir, constants.W_OK); return { name: "ast_db_dir_writable", ok: true, details: { dir } }; }
    catch { return { name: "ast_db_dir_writable", ok: false, reason: `${dir} not writable`, details: { dir } }; }
  },
];

export async function runInvariantChecks(): Promise<{ ok: boolean; checks: InvariantResult[] }> {
  const results = await Promise.all(checks.map(async (c) => {
    try { return await c(); }
    catch (err) { return { name: "unknown", ok: false, reason: `check threw: ${(err as Error).message}` }; }
  }));
  const ok = results.every((r) => r.ok);
  return { ok, checks: results };
}
