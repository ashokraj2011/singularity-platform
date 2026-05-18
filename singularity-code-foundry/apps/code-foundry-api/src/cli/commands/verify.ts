import axios from 'axios'

export async function verifyCommand(opts: { runId: string; api: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/runs/${encodeURIComponent(opts.runId)}/verify`
  const res = await axios.post(url, undefined, { timeout: 6 * 60_000, validateStatus: () => true })
  if (res.status === 503 && res.data?.code === 'FEATURE_DISABLED') {
    process.stderr.write(`✗ Feature disabled: ${res.data.flag}\n`)
    throw Object.assign(new Error('feature disabled'), { exitCode: 4 })
  }
  if (res.status >= 400) {
    process.stderr.write(`✗ ${res.status} ${url}\n${JSON.stringify(res.data, null, 2)}\n`)
    throw Object.assign(new Error('verify failed'), { exitCode: 2 })
  }
  const body = res.data as {
    status: string; toolchain: string; durationMs: number
    skippedReason?: string
    checks: Array<{ name: string; status: string; message: string; findings?: Array<{ kind: string; filePath?: string; message: string }> }>
  }
  process.stdout.write(`${body.status === 'PASSED' ? '✓' : body.status === 'SKIPPED' ? '○' : '✗'} verify (${body.toolchain}) — ${body.status} in ${body.durationMs}ms\n`)
  if (body.skippedReason) process.stdout.write(`    reason: ${body.skippedReason}\n`)
  for (const c of body.checks) {
    process.stdout.write(`    ${c.status === 'PASSED' ? '✓' : c.status === 'SKIPPED' ? '○' : '✗'} ${c.name.padEnd(20)} ${c.message}\n`)
    for (const f of c.findings ?? []) {
      process.stdout.write(`        • ${f.kind.padEnd(15)} ${f.filePath ?? ''}  ${f.message.slice(0, 200)}\n`)
    }
  }
  if (body.status !== 'PASSED' && body.status !== 'SKIPPED') {
    throw Object.assign(new Error(`verify exited ${body.status}`), { exitCode: 5 })
  }
}
