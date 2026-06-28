import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(7110),
  MCP_RUNNER_TOKEN: z.string().min(16),
  MCP_RUNNER_HOST_WORKSPACE_PATH: z.string().min(1),
  MCP_RUNNER_WORKSPACE_CONTAINER_PATH: z.string().default("/workspace"),
  MCP_RUNNER_DEFAULT_IMAGE: z.string().default("node:20-alpine"),
  MCP_RUNNER_IMAGE_MAP_JSON: z.string().optional(),
  MCP_RUNNER_NETWORK_MODE: z.string().default("none"),
  // SECURITY: per-request `network:"bridge"` is honored ONLY when this policy
  // opt-in is truthy; otherwise a per-request widen falls back to the global
  // MCP_RUNNER_NETWORK_MODE so an upstream caller can't enable egress per-run.
  MCP_RUNNER_ALLOW_REQUEST_NETWORK: z.string().default(""),
  MCP_RUNNER_CPU_LIMIT: z.string().default("1"),
  MCP_RUNNER_MEMORY_LIMIT: z.string().default("1g"),
  MCP_RUNNER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  MCP_RUNNER_TMPFS_SIZE: z.string().default("64m"),
  // (2026-05-26) Optional persistent build-tool cache. When set, the
  // runner bind-mounts this host directory as /root inside the sandbox
  // container (replacing the /root tmpfs). Build tools that cache
  // under $HOME — mvn (.m2), gradle (.gradle), pip (.cache/pip), cargo
  // (.cargo), npm/pnpm/yarn — keep their state across tool calls,
  // turning cold 5-minute `mvn clean install` runs into warm ~30s
  // runs. Off by default (tmpfs) so the production isolation contract
  // is unchanged; operators flip this in .env for local dev speed.
  // The path is shared by ALL workitems, so don't enable in a
  // multi-tenant context where cross-workitem cache leakage matters.
  MCP_RUNNER_HOST_BUILD_CACHE_PATH: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[mcp-sandbox-runner] invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const hostWorkspacePath = path.resolve(parsed.data.MCP_RUNNER_HOST_WORKSPACE_PATH);
if (!path.isAbsolute(parsed.data.MCP_RUNNER_HOST_WORKSPACE_PATH)) {
  console.error("[mcp-sandbox-runner] MCP_RUNNER_HOST_WORKSPACE_PATH must be an absolute host path");
  process.exit(1);
}

// Production-class secret gate. The runner is an arbitrary-code execution edge,
// so refuse to boot with the known dev default token in a real deployment. The
// runner image always sets NODE_ENV=production, so we key off the DEPLOYMENT env
// vars (APP_ENV/ENVIRONMENT/SINGULARITY_ENV), not NODE_ENV — dev keeps working.
const KNOWN_DEFAULT_RUNNER_TOKEN = "dev-mcp-runner-token-min-16-chars";
const DEPLOY_ENV = (process.env.APP_ENV || process.env.ENVIRONMENT || process.env.SINGULARITY_ENV || "development").toLowerCase();
const IS_PROD_CLASS = ["production", "prod", "staging", "perf"].includes(DEPLOY_ENV);
if (parsed.data.MCP_RUNNER_TOKEN === KNOWN_DEFAULT_RUNNER_TOKEN) {
  if (IS_PROD_CLASS) {
    console.error(`[mcp-sandbox-runner] FATAL: MCP_RUNNER_TOKEN is the known dev default in a ${DEPLOY_ENV} environment. Set a strong random MCP_RUNNER_TOKEN (16+ chars) and restart.`);
    process.exit(1);
  }
  console.warn("[mcp-sandbox-runner] WARNING: using the known dev default MCP_RUNNER_TOKEN — set a strong token before any shared-network deployment.");
}

export const runnerConfig = {
  ...parsed.data,
  MCP_RUNNER_HOST_WORKSPACE_PATH: hostWorkspacePath,
  MCP_RUNNER_ALLOW_REQUEST_NETWORK: ["1", "true", "yes"].includes(parsed.data.MCP_RUNNER_ALLOW_REQUEST_NETWORK.trim().toLowerCase()),
};
