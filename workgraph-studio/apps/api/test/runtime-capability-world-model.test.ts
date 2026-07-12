/**
 * Unit tests for getRuntimeCapabilityWorldModel — the agent-runtime
 * CapabilityWorldModel fetch that the laptop copilot forwards to prompt-composer
 * so it gets the CODE_WORLD_MODEL / CODE_AGENT_RULES grounding layers.
 *
 * We stub global fetch (the GET to agent-runtime) and pass an explicit auth
 * header so the IAM service-token path is skipped. Asserts: envelope unwrap, the
 * target endpoint, and best-effort null on 404 / 403 / network error.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { getRuntimeCapabilityWorldModel } from '../src/lib/agent-and-tools/client'

// Explicit header → resolvedAgentToolsAuthHeader returns it without calling
// getIamServiceToken(), so the only fetch is the world-model GET we mock.
const AUTH = 'Bearer test-token'

function mockJson(bodyObj: unknown, status = 200) {
  ;(global.fetch as Mock).mockResolvedValue(new Response(JSON.stringify(bodyObj), { status }))
}

describe('getRuntimeCapabilityWorldModel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('unwraps the {success,data} envelope and returns the world model', async () => {
    mockJson({ success: true, data: { primaryLanguage: 'java', buildSystem: 'maven' } })
    const wm = await getRuntimeCapabilityWorldModel('cap-1', AUTH)
    expect(wm).toEqual({ primaryLanguage: 'java', buildSystem: 'maven' })
  })

  it('hits the capability world-model endpoint', async () => {
    mockJson({ success: true, data: {} })
    await getRuntimeCapabilityWorldModel('cap-xyz', AUTH)
    const calledUrl = String((global.fetch as Mock).mock.calls[0][0])
    expect(calledUrl).toContain('/capabilities/cap-xyz/world-model')
  })

  it('returns null on 404 (world model not yet generated)', async () => {
    mockJson({ error: 'world model not yet generated' }, 404)
    expect(await getRuntimeCapabilityWorldModel('cap-1', AUTH)).toBeNull()
  })

  it('returns null on 403 (out of tenant scope)', async () => {
    mockJson({ error: 'forbidden' }, 403)
    expect(await getRuntimeCapabilityWorldModel('cap-1', AUTH)).toBeNull()
  })

  it('returns null when the fetch rejects (best-effort — never throws)', async () => {
    ;(global.fetch as Mock).mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await getRuntimeCapabilityWorldModel('cap-1', AUTH)).toBeNull()
  })
})
