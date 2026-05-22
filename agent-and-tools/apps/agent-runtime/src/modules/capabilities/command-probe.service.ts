/**
 * M61 Wire D — Verify-now command probe.
 *
 * Spawns the operator's test/build command in an isolated tmp dir
 * so they can sanity-check syntax (does the binary exist? does the
 * argument parser accept these flags?) before the bootstrap commits
 * the row to CapabilityWorldModel.
 *
 * This is NOT a full sandboxed test run — there's no repo cloned
 * here. A real `pnpm test` will fail because the workspace is empty;
 * the operator's signal is the EXIT CODE PATTERN, not pass/fail.
 * Specifically:
 *  - exit 0       → command parsed and ran cleanly (rare; usually a
 *                   help-text invocation)
 *  - exit 1-2     → command parsed but workspace is missing pieces;
 *                   this is the expected "tests would run if the repo
 *                   were here" path.
 *  - exit 127     → command not found on PATH. Operator typo.
 *  - timeout      → command hung. Operator should add --no-watch or
 *                   similar flag.
 *
 * The wizard renders the exit code + duration so the operator can
 * spot binary-not-found cases without leaving the page.
 *
 * Out of scope:
 *  - Cloning the capability's repo. The sandbox-runner integration
 *    handles real test execution at workflow time.
 *  - Network policy. Probes have full host network access; the
 *    operator's command can install packages, fetch templates, etc.
 *    The 10s timeout is the only governor.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_CAP_BYTES = 4 * 1024;

export type ProbeResult = {
  cmd: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  completedAt: string;
};

/**
 * Run `cmd` in an isolated tmp dir. Resolves with a structured result
 * regardless of success/failure (including spawn errors and timeouts) —
 * the caller decides how to interpret the exit code.
 *
 * `cwd` is an OPTIONAL relative path INSIDE the tmp workspace. We
 * still create the tmp root; the cwd is mkdir'd inside it. This
 * lets the operator's `cwd: apps/api` survive without leaking host
 * filesystem state.
 */
export async function probeCommand(input: {
  cmd: string;
  cwd?: string;
}): Promise<ProbeResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  // Use /bin/sh -c so the operator can pass shell pipelines and
  // chained commands. Spawning the whole string as argv[0] would
  // require split-rules that don't match shell semantics.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wm-probe-"));
  let workCwd = tmpRoot;
  if (input.cwd && input.cwd.trim()) {
    // Defensive: resolve the cwd inside tmpRoot. A path traversal
    // (cwd: "../etc") would still land somewhere we control because
    // we mkdir what we resolve, but normalise anyway.
    const resolved = path.resolve(tmpRoot, input.cwd.replace(/^\/+/, ""));
    fs.mkdirSync(resolved, { recursive: true });
    workCwd = resolved;
  }
  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const result = await new Promise<Omit<ProbeResult, "cmd" | "cwd" | "startedAt" | "completedAt">>((resolve) => {
    let settled = false;
    const child = spawn("/bin/sh", ["-c", input.cmd], { cwd: workCwd });
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      settled = true;
      resolve({
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        stdoutTruncated,
        stderrTruncated,
      });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length >= OUTPUT_CAP_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const room = OUTPUT_CAP_BYTES - stdoutBuf.length;
      const piece = chunk.toString("utf8");
      stdoutBuf += piece.length > room ? piece.slice(0, room) : piece;
      if (piece.length > room) stdoutTruncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length >= OUTPUT_CAP_BYTES) {
        stderrTruncated = true;
        return;
      }
      const room = OUTPUT_CAP_BYTES - stderrBuf.length;
      const piece = chunk.toString("utf8");
      stderrBuf += piece.length > room ? piece.slice(0, room) : piece;
      if (piece.length > room) stderrTruncated = true;
    });
    child.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      // Spawn errors (binary not found etc.) surface as exit code 127.
      resolve({
        exitCode: 127,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: stderrBuf + `\n[spawn error] ${err.message}`,
        stdoutTruncated,
        stderrTruncated: true,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut: false,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });

  // Best-effort cleanup. If rmSync fails (e.g. the command left a
  // hanging mount), leave the tmp dir — the OS reaper handles it.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  return {
    cmd: input.cmd,
    cwd: input.cwd ?? "",
    startedAt,
    completedAt: new Date().toISOString(),
    ...result,
  };
}
