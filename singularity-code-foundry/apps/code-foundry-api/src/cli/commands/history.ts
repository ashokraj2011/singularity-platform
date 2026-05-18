import axios from 'axios'

export async function historyCommand(opts: { id: string; api: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/specs/${encodeURIComponent(opts.id)}/history`
  const res = await axios.get(url, { timeout: 10_000, validateStatus: () => true })
  if (res.status === 503 && res.data?.code === 'FEATURE_DISABLED') {
    process.stderr.write(`✗ ${res.data.message}\n`)
    throw Object.assign(new Error('feature disabled'), { exitCode: 4 })
  }
  if (res.status === 404) {
    process.stderr.write(`✗ Spec ${opts.id} not found\n`)
    throw Object.assign(new Error('not found'), { exitCode: 2 })
  }
  if (res.status >= 400) {
    process.stderr.write(`✗ ${res.status} ${url}\n`)
    process.stderr.write(`  ${JSON.stringify(res.data)}\n`)
    throw Object.assign(new Error('history failed'), { exitCode: 2 })
  }
  const events = (res.data?.items ?? []) as Array<{
    occurredAt: string
    fromState?: string | null
    toState: string
    actorId?: string | null
    reason?: string | null
  }>
  for (const e of events) {
    const from = e.fromState ?? '∅'
    process.stdout.write(`  ${e.occurredAt}  ${from.padEnd(15)} → ${e.toState.padEnd(15)}  ${e.actorId ?? '-'}  ${e.reason ?? ''}\n`)
  }
  if (events.length === 0) {
    process.stdout.write('  (no events yet)\n')
  }
}
