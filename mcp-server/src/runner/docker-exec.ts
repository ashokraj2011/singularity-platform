import fs from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { runnerConfig } from "./config";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;
const ALLOWED_COMMANDS = new Set([
  "git",
  "rg",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "python",
  "python3",
  "pytest",
  "go",
  "cargo",
  "mvn",
  "gradle",
  "gradlew",
  "dotnet",
  "make",
]);

export const executeRequestSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  maxOutputChars: z.number().int().positive().max(MAX_OUTPUT_CHARS).optional(),
  profile: z.string().optional(),
});

export type ExecuteRequest = z.infer<typeof executeRequestSchema>;

type SpawnLike = typeof spawn;

interface DockerExecutionOptions {
  spawnImpl?: SpawnLike;
}

function safeRelativeCwd(cwd: string): string {
  const normalized = path.posix.normalize(cwd.replace(/\\/g, "/") || ".");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("cwd escapes the sandbox root");
  }
  return normalized === "." ? "." : normalized;
}

function validateRunnerCommand(command: string): void {
  if (/\s/.test(command) || path.isAbsolute(command) || command.includes("..") || /[|;&<>`]/.test(command) || command.includes("$(")) {
    throw new Error("command must be a single allowlisted executable without shell operators or traversal");
  }
  const base = command.startsWith("./") ? path.basename(command) : command;
  if (!ALLOWED_COMMANDS.has(base)) {
    throw new Error(`command '${command}' is not allowed by the runner policy`);
  }
}

function parseImageMap(): Record<string, string> {
  const raw = runnerConfig.MCP_RUNNER_IMAGE_MAP_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
}

function imageFor(command: string, profile?: string): string {
  const map = parseImageMap();
  if (profile && map[profile]) return map[profile];
  const base = command.startsWith("./") ? path.basename(command) : command;
  return map[base] ?? runnerConfig.MCP_RUNNER_DEFAULT_IMAGE;
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars * 0.65));
  const tail = value.slice(value.length - Math.floor(maxChars * 0.3));
  return `${head}\n... output truncated ...\n${tail}`;
}

function dockerRunArgs(req: ExecuteRequest, receiptId: string, containerName: string): string[] {
  validateRunnerCommand(req.command);
  const relCwd = safeRelativeCwd(req.cwd);
  const workspacePath = runnerConfig.MCP_RUNNER_WORKSPACE_CONTAINER_PATH.replace(/\/+$/, "");
  const workdir = relCwd === "." ? workspacePath : path.posix.join(workspacePath, relCwd);
  return [
    "run",
    "--rm",
    "--name", containerName,
    "--network", runnerConfig.MCP_RUNNER_NETWORK_MODE,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--cpus", runnerConfig.MCP_RUNNER_CPU_LIMIT,
    "--memory", runnerConfig.MCP_RUNNER_MEMORY_LIMIT,
    "--pids-limit", String(runnerConfig.MCP_RUNNER_PIDS_LIMIT),
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${runnerConfig.MCP_RUNNER_TMPFS_SIZE}`,
    // Writable HOME directory inside the read-only container. Required because
    // build tools cache state under $HOME:
    //   - mvn  → /root/.m2 (local repository)
    //   - gradle → /root/.gradle (wrapper + caches)
    //   - npm/pnpm/yarn → /root/.npm, /root/.local/share/pnpm
    //   - python/pip → /root/.cache/pip
    //   - cargo → /root/.cargo (when not pre-mounted)
    // Without this tmpfs, mvn fails with "Could not create local repository
    // at /root/.m2/repository" and the verification step never produces a
    // useful receipt. tmpfs keeps the cache ephemeral (gone when the runner
    // container exits) so there's no cross-invocation leakage.
    "--tmpfs", `/root:rw,size=${runnerConfig.MCP_RUNNER_TMPFS_SIZE}`,
    // Some images run as a non-root user (e.g. node:20-alpine sometimes
    // sets WORKDIR for `node` user). Provide /home with rw tmpfs too so
    // those paths can be written without conflicting with the read-only
    // root filesystem.
    "--tmpfs", `/home:rw,size=${runnerConfig.MCP_RUNNER_TMPFS_SIZE}`,
    "--label", `singularity.mcp.runner_receipt_id=${receiptId}`,
    "-v", `${runnerConfig.MCP_RUNNER_HOST_WORKSPACE_PATH}:${workspacePath}:rw`,
    "-w", workdir,
    imageFor(req.command, req.profile),
    req.command,
    ...req.args,
  ];
}

async function forceRemoveContainer(containerName: string, spawnImpl: SpawnLike): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawnImpl("docker", ["rm", "-f", containerName], { shell: false, env: { PATH: process.env.PATH ?? "" } });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export async function executeInDocker(req: ExecuteRequest, opts: DockerExecutionOptions = {}) {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const receiptId = `runner_${uuidv4()}`;
  const containerName = `mcp-runner-${receiptId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const args = dockerRunArgs(req, receiptId, containerName);
  const image = imageFor(req.command, req.profile);
  const started = Date.now();

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawnImpl("docker", args, { shell: false, env: { PATH: process.env.PATH ?? "" } }) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void forceRemoveContainer(containerName, spawnImpl);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });

  const durationMs = Date.now() - started;
  return {
    kind: "verification_result",
    verification_kind: "command",
    command: [req.command, ...req.args].join(" "),
    cwd: safeRelativeCwd(req.cwd),
    exit_code: result.exitCode,
    signal: result.signal,
    passed: result.exitCode === 0 && !result.timedOut,
    timed_out: result.timedOut,
    duration_ms: durationMs,
    stdout_excerpt: truncateOutput(result.stdout, maxOutputChars),
    stderr_excerpt: truncateOutput(result.stderr, maxOutputChars),
    execution_mode: "container",
    runner_receipt_id: receiptId,
    container_id: containerName,
    container_image: image,
    network_mode: runnerConfig.MCP_RUNNER_NETWORK_MODE,
    isolation: {
      runner: "mcp-sandbox-runner",
      network: runnerConfig.MCP_RUNNER_NETWORK_MODE,
      readonlyRoot: true,
      noNewPrivileges: true,
      capDrop: "ALL",
    },
  };
}

export function runnerHealth() {
  const workspaceExists = fs.existsSync(runnerConfig.MCP_RUNNER_HOST_WORKSPACE_PATH);
  let workspaceWritable = false;
  if (workspaceExists) {
    try {
      fs.accessSync(runnerConfig.MCP_RUNNER_HOST_WORKSPACE_PATH, fs.constants.W_OK);
      workspaceWritable = true;
    } catch {
      workspaceWritable = false;
    }
  }
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 1_500,
    env: { PATH: process.env.PATH ?? "" },
  });
  const dockerAvailable = docker.status === 0;
  const ready = workspaceExists && workspaceWritable && dockerAvailable;
  return {
    status: ready ? "ok" : "degraded",
    ready,
    service: "mcp-sandbox-runner",
    hostWorkspacePath: runnerConfig.MCP_RUNNER_HOST_WORKSPACE_PATH,
    hostWorkspaceExists: workspaceExists,
    hostWorkspaceWritable: workspaceWritable,
    dockerAvailable,
    dockerServerVersion: dockerAvailable ? docker.stdout.trim() : null,
    dockerError: dockerAvailable ? null : (docker.stderr || docker.error?.message || "docker daemon unavailable").trim(),
    workspaceContainerPath: runnerConfig.MCP_RUNNER_WORKSPACE_CONTAINER_PATH,
    defaultImage: runnerConfig.MCP_RUNNER_DEFAULT_IMAGE,
    imageMapConfigured: Boolean(runnerConfig.MCP_RUNNER_IMAGE_MAP_JSON?.trim()),
    networkMode: runnerConfig.MCP_RUNNER_NETWORK_MODE,
    readonlyRoot: true,
    noNewPrivileges: true,
    capDrop: "ALL",
    cpuLimit: runnerConfig.MCP_RUNNER_CPU_LIMIT,
    memoryLimit: runnerConfig.MCP_RUNNER_MEMORY_LIMIT,
    pidsLimit: runnerConfig.MCP_RUNNER_PIDS_LIMIT,
  };
}
