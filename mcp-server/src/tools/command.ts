import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ToolHandler } from "./registry";
import { config } from "../config";
import { resolveSandboxedPath, baseSandboxRoot } from "../workspace/sandbox";
import { callSandboxRunner } from "./runner-client";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
export const ALLOWED_COMMANDS = new Set([
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
const SHELL_TOKENS = new Set(["&&", "||", ";", "|", ">", ">>", "<", "`", "&"]);
const SECRET_TOKEN_RE = /(OPENAI|ANTHROPIC|OPENROUTER|COPILOT|GOOGLE|COHERE|TOKEN|SECRET|PASSWORD|KEY)/i;
const SCRIPT_ALLOW_RE = /^(test|lint|typecheck|type-check|check|build|verify|unit|integration|e2e)([:\w.-]*)?$/i;
const DENIED_VERBS = new Set([
  "install", "i", "add", "ci", "publish", "deploy", "release", "login",
  "logout", "token", "config", "link", "unlink", "create", "init", "exec",
  "dlx", "start", "serve", "dev", "run", "restore", "push", "pull", "fetch",
  "checkout", "switch", "reset", "clean", "commit", "tag", "merge", "rebase",
]);
const READONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "branch", "ls-files", "describe"]);

function parseCommandLine(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function normalizeInvocation(args: Record<string, unknown>): { command: string; argv: string[] } {
  const rawCommand = String(args.command ?? "").trim();
  const explicitArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : undefined;
  const parts = explicitArgs ? [rawCommand, ...explicitArgs] : parseCommandLine(rawCommand);
  const command = parts[0]?.trim();
  if (!command) throw new Error("command is required");
  const argv = parts.slice(1);
  for (const token of [command, ...argv]) {
    if (SHELL_TOKENS.has(token) || token.includes("$(") || /[|;&<>`]/.test(token)) {
      throw new Error("shell operators are not allowed; pass a single executable plus args");
    }
    if (SECRET_TOKEN_RE.test(token)) {
      throw new Error("secret-looking arguments or env references are not allowed in verification commands");
    }
  }
  if (/\s/.test(command) || path.isAbsolute(command) || command.includes("..")) {
    throw new Error("absolute command paths and traversal are not allowed");
  }
  const basename = command.startsWith("./") ? path.basename(command) : command;
  if (!ALLOWED_COMMANDS.has(basename)) {
    throw new Error(`command '${command}' is not in the MCP verification allowlist`);
  }
  validatePolicy(basename, argv);
  return { command, argv };
}

function firstNonOption(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith("-"));
}

function includesDeniedVerb(argv: string[]): string | undefined {
  return argv.map((arg) => arg.toLowerCase()).find((arg) => DENIED_VERBS.has(arg));
}

function scriptNameAfterRun(argv: string[]): string | undefined {
  const idx = argv.findIndex((arg) => arg === "run" || arg === "run-script");
  if (idx < 0) return undefined;
  return argv.slice(idx + 1).find((arg) => arg !== "--" && !arg.startsWith("-"));
}

function validatePackageManager(command: string, argv: string[]) {
  const verb = firstNonOption(argv);
  if (!verb) throw new Error(`${command} requires an explicit test/lint/typecheck/build script`);
  if (["--version", "-v"].includes(verb)) return;
  if (verb === "test" || verb === "build" || verb === "lint" || verb === "check") return;
  const script = scriptNameAfterRun(argv);
  if (script && SCRIPT_ALLOW_RE.test(script)) return;
  const denied = includesDeniedVerb(argv);
  if (denied) throw new Error(`${command} ${denied} is not allowed through MCP verification tools`);
  throw new Error(`${command} may only run test, lint, typecheck, build, check, or verify scripts`);
}

function validatePolicy(command: string, argv: string[]) {
  const denied = includesDeniedVerb(argv);
  if (["npm", "pnpm", "yarn"].includes(command)) return validatePackageManager(command, argv);
  if (command === "git") {
    const verb = firstNonOption(argv);
    if (!verb || !READONLY_GIT.has(verb)) throw new Error("git is limited to read-only status/diff/log/show/rev-parse/branch/ls-files/describe commands");
    if (verb === "branch" && argv.some((arg) => !arg.startsWith("-") && arg !== "branch")) {
      throw new Error("git branch is limited to read-only options such as --show-current");
    }
    return;
  }
  if (command === "rg") return;
  if (denied) throw new Error(`${command} ${denied} is not allowed through MCP verification tools`);
  if (command === "node") {
    if (argv[0] === "--test" || argv[0] === "-v" || argv[0] === "--version") return;
    throw new Error("node is limited to --test or version diagnostics");
  }
  if (command === "python" || command === "python3") {
    if (["-V", "--version"].includes(argv[0])) return;
    if (argv[0] === "-m" && ["pytest", "unittest", "compileall", "py_compile"].includes(argv[1] ?? "")) return;
    throw new Error("python is limited to -m pytest/unittest/compileall/py_compile or version diagnostics");
  }
  if (command === "pytest") return;
  if (command === "go") {
    if (["test", "vet", "build", "list", "version"].includes(argv[0] ?? "")) return;
    throw new Error("go is limited to test, vet, build, list, or version");
  }
  if (command === "cargo") {
    if (["test", "check", "build", "clippy"].includes(argv[0] ?? "")) return;
    if (argv[0] === "fmt" && argv.includes("--check")) return;
    throw new Error("cargo is limited to test, check, build, clippy, or fmt --check");
  }
  if (command === "mvn") {
    const goals = argv.filter((arg) => !arg.startsWith("-"));
    if (goals.length > 0 && goals.every((goal) => ["test", "verify", "compile", "package"].includes(goal))) return;
    throw new Error("mvn is limited to test, verify, compile, or package");
  }
  if (command === "gradle" || command === "gradlew") {
    const tasks = argv.filter((arg) => !arg.startsWith("-"));
    if (tasks.length > 0 && tasks.every((task) => SCRIPT_ALLOW_RE.test(task))) return;
    throw new Error("gradle is limited to test, lint, check, build, or verify tasks");
  }
  if (command === "dotnet") {
    if (["test", "build"].includes(argv[0] ?? "")) return;
    if (argv[0] === "format" && argv.includes("--verify-no-changes")) return;
    throw new Error("dotnet is limited to test, build, or format --verify-no-changes");
  }
  if (command === "make") {
    const targets = argv.filter((arg) => !arg.startsWith("-"));
    if (targets.length > 0 && targets.every((target) => SCRIPT_ALLOW_RE.test(target))) return;
    throw new Error("make requires explicit test/lint/typecheck/build/check/verify targets");
  }
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars * 0.65));
  const tail = value.slice(value.length - Math.floor(maxChars * 0.3));
  return `${head}\n... output truncated ...\n${tail}`;
}

async function runCommand(args: Record<string, unknown>, defaultKind: "command" | "test") {
  const { command, argv } = normalizeInvocation(args);
  const cwd = resolveSandboxedPath(typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : ".");
  const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0
    ? Math.min(Math.floor(args.timeout_ms), 10 * 60_000)
    : DEFAULT_TIMEOUT_MS;
  const maxOutputChars = typeof args.max_output_chars === "number" && args.max_output_chars > 0
    ? Math.min(Math.floor(args.max_output_chars), 100_000)
    : DEFAULT_MAX_OUTPUT_CHARS;
  // Critical: the sandbox-runner mounts BASE sandbox root (/workspace) into
  // the spawned container — NOT the workitem-scoped sandboxRoot(). If we
  // compute relativeCwd against sandboxRoot() and the agent passes cwd=".",
  // the runner ends up at /workspace (no pom.xml) instead of the workitem
  // dir (/workspace/.singularity/workitems/WRK-XXXX where pom.xml lives).
  // That manifested as "no POM in this directory" on every mvn invocation
  // even though the project file existed. Anchor the relative path to the
  // BASE root so the runner traverses into the workitem subdirectory.
  const relativeCwd = path.relative(baseSandboxRoot(), cwd) || ".";
  if (config.MCP_COMMAND_EXECUTION_MODE === "container") {
    const receipt = await callSandboxRunner({
      command,
      args: argv,
      cwd: relativeCwd,
      timeoutMs,
      maxOutputChars,
      profile: typeof args.profile === "string" ? args.profile : undefined,
    });
    return {
      success: true,
      output: {
        ...receipt,
        verification_kind: defaultKind,
      },
    };
  }

  const started = Date.now();

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(command, argv, { cwd, shell: false, env: safeCommandEnv() });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
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
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut: signal === "SIGTERM" || signal === "SIGKILL",
      });
    });
  });

  const durationMs = Date.now() - started;
  const commandLine = [command, ...argv].join(" ");
  return {
    success: true,
    output: {
      kind: "verification_result",
      verification_kind: defaultKind,
      command: commandLine,
      cwd: relativeCwd,
      exit_code: result.exitCode,
      signal: result.signal,
      passed: result.exitCode === 0 && !result.timedOut,
      timed_out: result.timedOut,
      duration_ms: durationMs,
      stdout_excerpt: truncateOutput(result.stdout, maxOutputChars),
      stderr_excerpt: truncateOutput(result.stderr, maxOutputChars),
      execution_mode: "process",
      network_mode: "host-process",
      isolation: {
        runner: "mcp-process",
        network: "host-process",
        readonlyRoot: false,
        noNewPrivileges: false,
      },
    },
  };
}

/**
 * Shared exported helper for auto-verification. Wraps the private runCommand
 * with the same command policy enforcement, sandbox scoping, and runner
 * isolation.
 */
export async function runVerificationCommand(opts: {
  command: string;
  args: string[];
  cwd?: string;
  timeout_ms?: number;
  max_output_chars?: number;
  profile?: string;
}): Promise<{
  success: boolean;
  output: Record<string, unknown>;
}> {
  return runCommand(
    {
      command: opts.command,
      args: opts.args, // runCommand expects 'args' to normalize explicit arguments inside normalizeInvocation
      cwd: opts.cwd,
      timeout_ms: opts.timeout_ms,
      max_output_chars: opts.max_output_chars,
      profile: opts.profile,
    },
    "test",
  ) as Promise<{ success: boolean; output: Record<string, unknown> }>;
}

function safeCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TMP: process.env.TMP ?? "/tmp",
    TEMP: process.env.TEMP ?? "/tmp",
    CI: process.env.CI ?? "true",
    NODE_ENV: process.env.NODE_ENV ?? "test",
  };
  if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
  if (process.env.PNPM_HOME) env.PNPM_HOME = process.env.PNPM_HOME;
  return env;
}

const commandInputSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Executable or simple command line, for example 'npm test'." },
    args: { type: "array", items: { type: "string" }, description: "Optional argv array. Prefer this for commands with quoted args." },
    cwd: { type: "string", description: "Sandbox-relative working directory. Defaults to sandbox root." },
    timeout_ms: { type: "number", description: "Timeout in milliseconds, max 600000." },
    max_output_chars: { type: "number", description: "Maximum stdout/stderr excerpt chars." },
    profile: { type: "string", description: "Optional runner image/profile key for container execution." },
  },
  required: ["command"],
};

// Strict allowlist mirrored from ALLOWED_COMMANDS / SHELL_TOKENS above. Surfaced
// in the tool description so the LLM can pick a valid invocation up front instead
// of probing with `find`/`ls`/pipes (which silently fail and waste agent steps).
const RUN_COMMAND_ALLOWLIST_HINT =
  "Allowed executables: git, rg, npm, pnpm, yarn, node, python, python3, pytest, go, cargo, mvn, gradle, gradlew, dotnet, make. " +
  "Shell operators are REJECTED: no pipes (|), redirects (>, <, 2>), chaining (&&, ||, ;), command substitution ($(...), backticks). " +
  "Do NOT use this tool for filesystem inspection — `cat`, `find`, `grep`, `ls`, `wc`, `head`, `tail` are NOT allowlisted. " +
  "Use dedicated MCP tools instead, all of which are sandbox-scoped and far more token-efficient: " +
  "read_file (cat), find_files (find -name), grep_lines (grep -A/-B with context), search_code (grep without context), " +
  "list_directory (ls), file_stats (wc -l / stat), get_ast_slice (cat on a line range). " +
  "Pass executable + args, e.g. {\"command\": \"mvn\", \"args\": [\"test\"]} or {\"command\": \"rg\", \"args\": [\"-n\", \"pattern\", \"src/\"]}.";

export const runCommandTool: ToolHandler = {
  descriptor: {
    name: "run_command",
    description:
      "Run an allowlisted non-shell command inside the MCP sandbox and return stdout/stderr evidence. " +
      RUN_COMMAND_ALLOWLIST_HINT,
    natural_language:
      "Use this for build, lint, typecheck, or diagnostic commands that are on the MCP allowlist. It does not run through a shell. " +
      "To explore the workspace use list_directory / search_code / read_file instead of find/ls/grep.",
    input_schema: commandInputSchema,
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      return await runCommand(args, "command");
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

export const runTestTool: ToolHandler = {
  descriptor: {
    name: "run_test",
    description:
      "Run an allowlisted test or verification command inside the MCP sandbox and return a verification receipt. " +
      RUN_COMMAND_ALLOWLIST_HINT,
    natural_language:
      "Use this after code edits during Dev or QA stages to capture test, lint, typecheck, or formal verification evidence.",
    input_schema: commandInputSchema,
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      return await runCommand(args, "test");
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

export const verificationUnavailableTool: ToolHandler = {
  descriptor: {
    name: "verification_unavailable",
    description: "Record an explicit verification-unavailable receipt when no runnable test, lint, typecheck, or formal verification command exists.",
    natural_language:
      "Use this after code edits only when repo inspection found no runnable verification command. Include the reason and any files or commands inspected.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why verification could not be run." },
        inspected: { type: "array", items: { type: "string" }, description: "Files or signals inspected, for example package.json or README." },
        attemptedCommands: { type: "array", items: { type: "string" }, description: "Commands considered or attempted before deciding unavailable." },
        paths_context: { type: "array", items: { type: "string" }, description: "Changed or relevant paths." },
      },
      required: ["reason"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const reason = String(args.reason ?? "").trim();
    if (!reason) return { success: false, output: null, error: "reason is required" };
    const inspected = Array.isArray(args.inspected) ? args.inspected.map(String).filter(Boolean) : [];
    const attemptedCommands = Array.isArray(args.attemptedCommands) ? args.attemptedCommands.map(String).filter(Boolean) : [];
    const pathsContext = Array.isArray(args.paths_context) ? args.paths_context.map(String).filter(Boolean) : [];
    return {
      success: true,
      output: {
        kind: "verification_result",
        verification_kind: "unavailable",
        command: "verification_unavailable",
        passed: true,
        unavailable: true,
        risk_accepted_required: true,
        reason,
        inspected,
        attempted_commands: attemptedCommands,
        paths_context: pathsContext,
        duration_ms: 0,
      },
    };
  },
};
