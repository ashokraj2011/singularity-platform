import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { SingularityLaptopSdk } from '../src/index.js'

type RequestHarness = {
  request<T>(method: string, path: string, body?: unknown): Promise<T>
}

describe('SingularityLaptopSdk request parsing', () => {
  let originalFetch: typeof fetch

  before(() => {
    originalFetch = globalThis.fetch
  })

  after(() => {
    globalThis.fetch = originalFetch
  })

  it('accepts successful empty responses', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch
    const sdk = new SingularityLaptopSdk({ apiBaseUrl: 'https://singularity.test', tokenProvider: () => 'token' })

    const result = await (sdk as unknown as RequestHarness).request<void>('POST', '/heartbeat', {})

    assert.equal(result, undefined)
  })

  it('reports non-JSON success bodies with request context', async () => {
    globalThis.fetch = (async () => new Response('Internal Server Error', { status: 200 })) as typeof fetch
    const sdk = new SingularityLaptopSdk({ apiBaseUrl: 'https://singularity.test', tokenProvider: () => 'token' })

    await assert.rejects(
      () => (sdk as unknown as RequestHarness).request('GET', '/status'),
      /GET \/status returned non-JSON response: Internal Server Error/,
    )
  })
})
