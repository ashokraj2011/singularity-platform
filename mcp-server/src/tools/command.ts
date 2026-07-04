import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ToolHandler } from "./registry";
import { config } from "../config";
import { log } from "../shared/log";
import { resolveSandboxedPath, baseSandboxRoot } from "../workspace/sandbox";
import { callSandboxRunner } from "./runner-client";

/**
 * M70.1 — Detect test runs that exited successfully but actually ran
 * ZERO tests. Most runners return exit 0 when a test-filter matches no
 * methods (e.g. `mvn test -Dtest=NoSuchClass#noSuchMethod`), which made
 * the agent report passed:true with latency_ms around 700 — well below
 * what a real test takes. Downstream gates (formal verifier, M66
 * cross-stage threading) trusted that "passing" receipt and let bad
 * code through.
 *
 * Returns:
 *   - { noTests: true, reason } when the output is positively a "zero
 *     tests ran" signal. Caller should override passed:false.
 *   - { noTests: false } when the output looks like a real test run
 *     (counted tests > 0) OR is genuinely ambiguous.
 *
 * Conservative on purpose: only return noTests:true when there's a
 * specific phrase from a known runner. An unparseable test output is
 * NOT flagged — better to under-flag than to mis-flag real passes.
 *
 * Covers Maven/JUnit, pytest, Python unittest, Jest, Vitest, Go test,
 * Cargo test, dotnet test, mocha, RSpec.
 */
export function detectNoTestsRan(stdout: string, stderr: string): { noTests: true; reason: string } | { noTests: false } {
  // Combine streams; runners scatter the count across either.
  const blob = `${stdout}\n${stderr}`;
  // Maven/JUnit: prints a per-module line like
  //   "Tests run: 0, Failures: 0, Errors: 0, Skipped: 0"
  // Maven Surefire's BUILD SUCCESS with `Tests run: 0` is the classic
  // agent footgun: `-Dtest=foo#bar*` matched nothing.
  const maven = blob.match(/Tests run:\s*(\d+)(?:,|\s)/i);
  if (maven && Number(maven[1]) === 0) {
    return { noTests: true, reason: "maven/junit: Tests run: 0 (filter matched no methods)" };
  }
  // Maven also prints "No tests to run." when surefire skips everything.
  if (/no tests to run\.?/i.test(blob)) {
    return { noTests: true, reason: "maven: 'No tests to run' — verify your -Dtest filter" };
  }
  // pytest: "collected 0 items" or "no tests ran in"
  if (/collected\s+0\s+items?\b/.test(blob)) {
    return { noTests: true, reason: "pytest: collected 0 items (no tests matched)" };
  }
  if (/no tests ran in/i.test(blob)) {
    return { noTests: true, reason: "pytest: no tests ran" };
  }
  // Python unittest: "Ran 0 tests in"
  if (/Ran\s+0\s+tests?\s+in/i.test(blob)) {
    return { noTests: true, reason: "unittest: Ran 0 tests" };
  }
  // Jest / Vitest: print a summary "Tests: 0 total" (with optional
  // failure/pass counts elsewhere). Use the explicit "0 total" anchor.
  const jest = blob.match(/Tests?:[^,\n]*\b(\d+)\s+total/i);
  if (jest && Number(jest[1]) === 0) {
    return { noTests: true, reason: "jest/vitest: 0 total tests" };
  }
  // Jest "No tests found" / "No tests matched"
  if (/no tests (?:found|matched|to run)/i.test(blob)) {
    return { noTests: true, reason: "jest: no tests found/matched" };
  }
  // Go: `go test ./...` with no test files emits
  //   "?   pkg/foo  [no test files]"
  // and `-run X` with no matches emits
  //   "testing: warning: no tests to run"
  if (/no test files\b/.test(blob) && !/\bok\s/.test(blob)) {
    return { noTests: true, reason: "go: no test files" };
  }
  if (/testing:\s*warning:\s*no tests to run/i.test(blob)) {
    return { noTests: true, reason: "go: no tests matched -run filter" };
  }
  // Cargo: "running 0 tests" then "test result: ok. 0 passed"
  if (/running\s+0\s+tests?\b/i.test(blob)) {
    return { noTests: true, reason: "cargo: running 0 tests" };
  }
  // dotnet test: "Total tests: 0" or "No test is available"
  if (/Total tests:\s*0\b/i.test(blob)) {
    return { noTests: true, reason: "dotnet: Total tests: 0" };
  }
  if (/no test is available/i.test(blob)) {
    return { noTests: true, reason: "dotnet: no test available" };
  }
  // Mocha: "0 passing" with no other test counts is suspicious
  if (/^\s*0 passing\b/m.test(blob) && !/\d+ failing\b/i.test(blob) && !/\d+ pending\b/i.test(blob)) {
    return { noTests: true, reason: "mocha: 0 passing, no failures or pending" };
  }
  // RSpec: "0 examples, 0 failures"
  if (/\b0 examples?,\s*0 failures?\b/i.test(blob)) {
    return { noTests: true, reason: "rspec: 0 examples" };
  }
  return { noTests: false };
}

/**
 * M70.1 — Apply the no-tests-ran override to a raw receipt. Only acts
 * when verification_kind is "test" (run_command is NOT a test and
 * shouldn't be second-guessed). Returns the receipt unchanged when the
 * runner output looks like a real test run or is genuinely ambiguous.
 */
function applyNoTestsOverride<T extends Record<string, unknown>>(receipt: T, verificationKind: string): T {
  if (verificationKind !== "test") return receipt;
  if (receipt.passed !== true) return receipt;  // already failed — nothing to flip
  const stdout = typeof receipt.stdout_excerpt === "string" ? receipt.stdout_excerpt : "";
  const stderr = typeof receipt.stderr_excerpt === "string" ? receipt.stderr_excerpt : "";
  const check = detectNoTestsRan(stdout, stderr);
  if (!check.noTests) return receipt;
  return {
    ...receipt,
    passed: false,
    no_tests_ran: true,
    no_tests_ran_reason: check.reason,
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
// M44 — Lowered from 12_000 to 8_000 to align with the Workbench/MCP-default
// max_tool_result_chars. Explicit caller `max_output_chars` still overrides.
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const PROCESS_KILL_GRACE_MS = config.MCP_PROCESS_KILL_GRACE_MS;
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
// M47.A — When run_command rejects a classic OS verb, point the model at the
// MCP-native tool that does the same job. Keys are command basenames; values
// are the suggested tool-call form. Exhaustive over the verbs in the M44/v4.4
// prompt's "Never use these OS verbs" table.
const OS_VERB_SUGGESTIONS: Record<string, string> = {
  find:  "find_files(pattern)",
  grep:  "search_code(query)  // or grep_lines for context",
  cat:   "read_file(path)  // or get_ast_slice for a known line range",
  wc:    "file_stats(paths)  // or list_indexed_files for code files",
  ls:    "list_directory(path)",
  head:  "read_file(path) and slice client-side, or get_ast_slice(startLine, endLine)",
  tail:  "read_file(path) and slice client-side, or get_ast_slice(startLine, endLine)",
  sed:   "replace_text(path, oldText, newText)",
  awk:   "search_code or read_file then process",
};
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
    // M47.A — When the rejected verb is a classic OS file inspection tool,
    // include the MCP-native replacement in the error message. The model
    // tends to fall back to `find`/`grep`/`cat`/`wc`/`ls` even after the
    // v4.4 prompt warns against them; surfacing the equivalent at point
    // of rejection short-circuits the retry loop the audit log keeps showing.
    const suggestion = OS_VERB_SUGGESTIONS[basename];
    const tail = suggestion ? ` — use \`${suggestion}\` (MCP-native, sandbox-scoped, token-efficient) instead` : "";
    throw new Error(`command '${command}' is not in the MCP verification allowlist${tail}`);
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
  // M51 — Build-tool checks are ALLOW-first: explicitly enumerate legal
  // goals/subcommands. The generic denied-verb backstop runs AFTER, so
  // build-tool-specific tokens (e.g. mvn's `clean` goal, gradle's `clean`
  // task) don't get blocked by the package-manager-oriented deny list.
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
    // M51 — `clean` added: standard Maven lifecycle goal that just removes
    // the local target/ dir — analogous to `cargo clean`. Not destructive
    // outside the build output, and operators routinely run `mvn clean test`
    // for a hermetic verify. The npm-oriented "clean" deny rule doesn't
    // apply here.
    if (goals.length > 0 && goals.every((goal) => ["test", "verify", "compile", "package", "clean"].includes(goal))) return;
    throw new Error("mvn is limited to test, verify, compile, package, or clean");
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
  // M51 — Generic denied-verb backstop. Reached only for commands that
  // weren't matched by any allow-first block above. Catches things like a
  // future allow-listed command being misused with a destructive verb.
  const denied = includesDeniedVerb(argv);
  if (denied) throw new Error(`${command} ${denied} is not allowed through MCP verification tools`);
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars * 0.65));
  const tail = value.slice(value.length - Math.floor(maxChars * 0.3));
  return `${head}\n... output truncated ...\n${tail}`;
}

async function runCommand(args: Record<string, unknown>, defaultKind: "command" | "test" | "baseline") {
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
    // M70.1 — Override passed:true when the test runner reports zero
    // tests ran. Otherwise `mvn test -Dtest=foo#wrongName*` returns
    // exit 0 in 700ms and downstream gates trust the "passed" signal.
    const withOverride = applyNoTestsOverride({ ...receipt, verification_kind: defaultKind }, defaultKind);
    // M72 Slice D — Attach structured test report (JUnit XML / pytest
    // json-report) when available. The container path's cwd is mapped to
    // the workitem workspace on the host; we read from `cwd` directly
    // because Maven/Gradle/pytest write their report artifacts there.
    const withReport = await attachStructuredTestReport(withOverride, cwd, command, defaultKind);
    return {
      success: true,
      output: withReport,
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
      setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS).unref();
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
  // M70.1 — Same override here as in the container path. The process
  // path is used in dev / when MCP_COMMAND_EXECUTION_MODE != container;
  // both paths share the same "test exited 0 but ran zero tests"
  // false-positive risk.
  const output = applyNoTestsOverride({
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
  }, defaultKind);
  // M72 Slice D — Same structured-report attachment as the container path.
  const outputWithReport = await attachStructuredTestReport(output, cwd, command, defaultKind);
  return { success: true, output: outputWithReport };
}

/**
 * M72 Slice D — Look for JUnit XML / pytest json-report artifacts in `cwd`
 * and attach a `parsed_tests` block to the receipt. Falls back silently
 * when no structured report is found (caller uses stdout heuristic later).
 *
 * The structured parse is authoritative: downstream baseline-diff code
 * checks for `parsed_tests` first and skips `parseTestRunnerOutput(stdout)`
 * when it's present. That removes the regex fragility for Maven/Gradle/
 * pytest while keeping legacy frameworks (Jest, Go, Cargo) on the stdout
 * path until their adapters land.
 */
async function attachStructuredTestReport<T extends Record<string, unknown>>(
  receipt: T,
  cwd: string,
  command: string,
  defaultKind: "command" | "test" | "baseline",
): Promise<T> {
  // Only test/baseline kinds benefit from structured reports. Generic
  // `command` runs don't write test artifacts.
  if (defaultKind !== "test" && defaultKind !== "baseline") return receipt;
  try {
    const { findAndParseStructuredReport } = await import("./test-report-parser");
    const parsed = await findAndParseStructuredReport(cwd, command);
    if (parsed) {
      return {
        ...receipt,
        parsed_tests: parsed,
        // Helpful for downstream: explicit signal that the parse came from
        // a real report file, not the stdout heuristic. Audit-gov + workbench
        // can render this differently ("48 passed via surefire" vs
        // "exit 0 — no structured report").
        parsed_tests_source: "structured_report",
      } as T;
    }
  } catch (err) {
    // Never let report parsing fail the underlying command. Log + move on.
    // The stdout heuristic in parseTestRunnerOutput still applies downstream.
    log.warn({ err: (err as Error).message, command }, "structured test-report parse failed");
  }
  return receipt;
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

// ─────────────────────────────────────────────────────────────────────────
// M48 — Test-baseline capture for the "ignore pre-existing failures" flow.
//
// The RuleEngine workflow exposed a class of failure that the verification
// gate currently treats as a regression: the upstream `main` branch has
// pre-existing broken tests (Map.of("k","v","k2",null) — NPE on Java 9+).
// `mvn test` fails for reasons unrelated to the agent's edit.
//
// The flow this enables:
//   1. Early in PLAN_DRAFT or EXPLORE the agent calls capture_test_baseline.
//      That runs the verifier against the CURRENT branch (no edits yet) and
//      records which tests fail.
//   2. After ACT, the agent calls run_test as usual. invoke.ts joins the two
//      receipts and computes per-test deltas (pre_existing_failures /
//      regressions / new_failures / new_passes).
//   3. The workgraph verification gate blocks only on regressions + new
//      failures, not pre-existing failures.
// ─────────────────────────────────────────────────────────────────────────

export const captureTestBaselineTool: ToolHandler = {
  descriptor: {
    name: "capture_test_baseline",
    description:
      "Run the project's verifier against the CURRENT branch state (no edits yet) and tag the receipt as a baseline. " +
      "Use this in EARLY EXPLORE on the Develop stage to anchor pre-existing test failures — they then won't be confused " +
      "with regressions when run_test runs again after your edits. Without a baseline, the verification gate treats every " +
      "failure (including upstream-broken tests) as a blocker. With a baseline, pre-existing failures pass through as " +
      "informational; only NEW failures or tests-that-were-passing-and-now-fail block approval.",
    natural_language:
      "Use this once near the start of Develop, BEFORE making code edits. Same arguments as run_test (command + args + cwd). " +
      "The resulting receipt is stored as the baseline for this run.",
    input_schema: commandInputSchema,
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      return await runCommand(args, "baseline");
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

/**
 * M48 — Parse a verifier stdout to extract per-test pass/fail status.
 *
 * Currently supports Maven Surefire output. Other runners (pytest, vitest,
 * gradle, etc.) get added as we need them — the function returns an
 * "unparseable" tag so the caller can still surface the raw output without
 * losing signal.
 *
 * Exported for testability.
 */
export interface ParsedTestResults {
  format: "maven" | "unparseable";
  totalTests?: number;
  passingTests: string[];   // fully-qualified test names that passed
  failingTests: string[];   // fully-qualified test names that failed
  errorSummary?: string;    // one-line "X failures, Y errors"
}

export function parseTestRunnerOutput(stdout: string, command: string): ParsedTestResults {
  const cmd = command.toLowerCase();
  // Maven Surefire — lines of the form:
  //   [ERROR] org.example.rules.RuleEngineServiceTest.testIsNull -- Time elapsed ...
  //   [ERROR]   RuleEngineServiceTest.testIsNotNull:167 » NullPointer
  // Plus a summary:  Tests run: 19, Failures: 0, Errors: 2, Skipped: 0
  if (cmd.includes("mvn") || cmd.includes("maven")) {
    // Collect both FQN form and short summary form, then dedupe by the
    // (className, methodName) tail. We prefer the FQN when both appear.
    const fqnSet = new Set<string>();
    const shortSet = new Set<string>();
    for (const line of stdout.split("\n")) {
      const fullFqn = line.match(/^\[ERROR\] ([a-zA-Z_][\w.]*\.\w+)\b.* -- Time elapsed/);
      if (fullFqn) { fqnSet.add(fullFqn[1]); continue; }
      const short = line.match(/^\[ERROR\]\s+(\w+\.\w+):\d+\s+»/);
      if (short) { shortSet.add(short[1]); continue; }
    }
    const tail = (s: string): string => s.split(".").slice(-2).join(".");
    const fqnByTail = new Map<string, string>();
    for (const fqn of fqnSet) fqnByTail.set(tail(fqn), fqn);
    const failingSet = new Set<string>(fqnSet);
    for (const sh of shortSet) {
      // Only add the short form if we don't already have its FQN equivalent.
      if (!fqnByTail.has(sh)) failingSet.add(sh);
    }
    const summary = stdout.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/);
    const totalTests = summary ? Number(summary[1]) : undefined;
    return {
      format: "maven",
      totalTests,
      // We can't enumerate the passing set reliably from stdout (Maven only
      // logs the failing ones by default); the empty array means "unknown
      // but presumed = totalTests - failing.length". Downstream consumers
      // use failingTests sets for the diff.
      passingTests: [],
      failingTests: [...failingSet],
      errorSummary: summary ? `${summary[2]} failure(s), ${summary[3]} error(s)${summary[4] ? `, ${summary[4]} skipped` : ""}` : undefined,
    };
  }
  return { format: "unparseable", passingTests: [], failingTests: [] };
}

/**
 * M48 — Compute the diff between a baseline test run and a post-edit run.
 * Returns the categorisation the workgraph verification gate consumes.
 */
export interface VerificationDiff {
  pre_existing_failures: string[];  // failing at baseline AND still failing → informational
  regressions: string[];            // passing-by-omission at baseline (not in failing set), failing now → blocker
  fixed: string[];                  // failing at baseline, passing now (the agent fixed something)
  new_failures: string[];           // appeared in postFailing, weren't observed at baseline at all → blocker (usually new tests that fail)
  hasRegressions: boolean;
}

export function diffTestResults(baseline: ParsedTestResults, post: ParsedTestResults): VerificationDiff {
  const baselineFailing = new Set(baseline.failingTests);
  const postFailing = new Set(post.failingTests);

  const pre_existing_failures: string[] = [];
  const fixed: string[] = [];

  for (const t of baselineFailing) {
    if (postFailing.has(t)) pre_existing_failures.push(t);
    else fixed.push(t);
  }
  // post failures not present in baseline → either new tests OR pre-existing
  // tests that the agent broke. We can't distinguish without a baseline test
  // inventory, so all are treated as regressions/new_failures (both blocking).
  // The caller can split them later by checking whether the test name was
  // mentioned in any changed test file's diff.
  const newOrRegressed = [...postFailing].filter(t => !baselineFailing.has(t));

  return {
    pre_existing_failures,
    regressions: newOrRegressed,  // conservative: all post-only failures block until split
    fixed,
    new_failures: [],
    hasRegressions: newOrRegressed.length > 0,
  };
}
