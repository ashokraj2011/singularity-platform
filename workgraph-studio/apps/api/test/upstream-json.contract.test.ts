import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  isJsonObject,
  readUpstreamJsonBody,
  readUpstreamJsonObjectOrNull,
  upstreamSnippet,
} from '../src/lib/upstream-json'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('shared upstream JSON helper', () => {
  it('normalizes valid, malformed, empty, and non-object response bodies', async () => {
    await expect(readUpstreamJsonBody(new Response('{"ok":true}', { status: 200 })))
      .resolves.toMatchObject({ data: { ok: true } })

    await expect(readUpstreamJsonBody(new Response('Internal Server Error', { status: 200 })))
      .resolves.toMatchObject({ data: 'Internal Server Error', parseError: expect.any(String) })

    await expect(readUpstreamJsonBody(new Response('', { status: 200 })))
      .resolves.toMatchObject({ raw: '', data: null })

    await expect(readUpstreamJsonObjectOrNull(new Response('[1,2,3]', { status: 200 })))
      .resolves.toMatchObject({ data: null })

    expect(isJsonObject({ ok: true })).toBe(true)
    expect(isJsonObject([1, 2, 3])).toBe(false)
    expect(upstreamSnippet(' one\n\n two\t three ', 20)).toBe('one two three')
  })

  it('keeps raw response parsing centralized in one helper', () => {
    for (const file of [
      'src/lib/audit-gov/client.ts',
      'src/lib/context-fabric/client.ts',
      'src/lib/prompt-composer/client.ts',
      'src/lib/iam/client.ts',
      'src/lib/agent-and-tools/client.ts',
      'src/modules/identity/auth.router.ts',
      'src/modules/event-horizon/event-horizon.router.ts',
      'src/modules/contracts/contracts.router.ts',
      'src/modules/workflow/insights.router.ts',
      'src/modules/audit/receipts.router.ts',
      'src/lib/learning/record-run-learning.ts',
      'src/modules/runtime/llm-models.router.ts',
      'src/modules/laptop/laptop.service.ts',
      'src/modules/workflow/runtime/executors/mcpToolGrant.ts',
    ]) {
      const text = source(file)
      expect(text, `${file} should use readUpstreamJsonBody`).toContain('readUpstreamJsonBody')
      expect(text, `${file} should not parse upstream text inline`).not.toMatch(/JSON\.parse\(raw\)|JSON\.parse\(text\)/)
    }

    const serviceToken = source('src/lib/iam/service-token.ts')
    expect(serviceToken).toContain('readUpstreamJsonBody')
    expect(serviceToken).not.toMatch(/JSON\.parse\(text\)/)
  })
})
