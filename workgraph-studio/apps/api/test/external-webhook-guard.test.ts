import { describe, expect, it } from 'vitest'
import { guardExternalWebhookUrl } from '../src/modules/workflow/runtime/external-webhook'

// The EXTERNAL webhook is an OUTBOUND call to a config-supplied URL, so it must be
// the INVERSE of the internal api-caller guard: allow only PUBLIC destinations, and
// block loopback / private / link-local (incl. cloud metadata). IP-literal cases
// resolve synchronously (no DNS), so they are deterministic in unit tests.
describe('external webhook SSRF guard (public-only)', () => {
  it('allows a public IP literal', async () => {
    const r = await guardExternalWebhookUrl('https://8.8.8.8/hook')
    expect(r.ok).toBe(true)
  })

  it('blocks loopback', async () => {
    const r = await guardExternalWebhookUrl('http://127.0.0.1/hook')
    expect(r.ok).toBe(false)
  })

  it('blocks private ranges', async () => {
    for (const host of ['10.1.2.3', '192.168.0.5', '172.16.0.1']) {
      const r = await guardExternalWebhookUrl(`http://${host}/hook`)
      expect(r.ok, host).toBe(false)
    }
  })

  it('blocks the cloud metadata link-local address', async () => {
    const r = await guardExternalWebhookUrl('http://169.254.169.254/latest/meta-data/')
    expect(r.ok).toBe(false)
  })

  it('rejects non-http(s) protocols', async () => {
    const r = await guardExternalWebhookUrl('file:///etc/passwd')
    expect(r.ok).toBe(false)
  })
})
