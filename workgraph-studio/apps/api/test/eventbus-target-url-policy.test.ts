import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { assertEventTargetUrlAllowed } from '../src/lib/eventbus/target-url-policy'

async function rejects(pattern: RegExp, fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow(pattern)
}

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('event bus target URL policy', () => {
  it('allows public HTTP(S) webhook targets', async () => {
    const url = await assertEventTargetUrlAllowed('https://93.184.216.34/webhook')
    expect(url.protocol).toBe('https:')
  })

  it('blocks non-web, credentialed, private, local, and metadata targets', async () => {
    await rejects(/absolute/, () => assertEventTargetUrlAllowed('/webhook'))
    await rejects(/http or https/, () => assertEventTargetUrlAllowed('file:///etc/passwd'))
    await rejects(/embedded credentials/, () => assertEventTargetUrlAllowed('https://embedded-user@example.com/webhook'))
    await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed('http://localhost:8080/webhook'))
    await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed('http://127.0.0.1:8080/webhook'))
    await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed('http://10.0.0.5/webhook'))
    await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed('http://169.254.169.254/latest/meta-data'))
    await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed('http://metadata.google.internal/computeMetadata/v1'))
  })

  it('validates event subscription targets on write and delivery', () => {
    const router = source('src/modules/audit/event-subscriptions.router.ts')
    const dispatcher = source('src/lib/eventbus/dispatcher.ts')

    expect(router).toContain('assertEventTargetUrlAllowed(body.targetUrl)')
    expect(router).toContain('if (body.targetUrl !== undefined)')
    expect(router).toContain('throw new ValidationError((err as Error).message)')
    expect(dispatcher).toContain('const safeUrl = await assertEventTargetUrlAllowed(targetUrl)')
    expect(dispatcher).toContain('fetch(safeUrl,')
  })
})
