/**
 * M42.3 — Shell out, capture stdout/stderr, never throw.
 */
import { spawn } from 'node:child_process'

export interface RunResult {
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  available: boolean   // false when the binary wasn't on PATH at all
}

export async function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<RunResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      proc = spawn(command, args, { cwd: opts.cwd })
    } catch (err) {
      resolve({
        exitCode: -1,
        signal: null,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: Date.now() - started,
        available: false,
      })
      return
    }
    proc.on('error', (err) => {
      // ENOENT bubbles here when the binary isn't on PATH. Resolve as
      // "not available" so the caller can mark the verification SKIPPED.
      resolve({
        exitCode: -1,
        signal: null,
        stdout,
        stderr: err.message,
        durationMs: Date.now() - started,
        available: (err as NodeJS.ErrnoException).code !== 'ENOENT',
      })
    })
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = opts.timeoutMs
      ? setTimeout(() => proc?.kill('SIGTERM'), opts.timeoutMs)
      : undefined
    proc.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        available: true,
      })
    })
  })
}

export function tail(s: string, maxChars = 4_000): string {
  if (s.length <= maxChars) return s
  return s.slice(-maxChars)
}
