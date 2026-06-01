/**
 * SSRF guard unit tests (security review #3 — api-call proxy).
 *
 * Pins the IP-classification + URL-precheck logic that decides whether the
 * workbench api-call proxy may connect to a target. The route additionally
 * DNS-resolves hostnames and pins the connection to a validated IP; this file
 * covers the pure pieces that decide private-vs-public.
 */
import { describe, expect, it } from 'vitest'

import { classifyAddress, isBlockedAddress, precheckTargetUrl } from '../src/lib/ssrf-guard'

describe('classifyAddress — IPv4', () => {
  it('loopback / private ranges', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback')
    expect(classifyAddress('10.1.2.3')).toBe('private')
    expect(classifyAddress('192.168.0.5')).toBe('private')
    expect(classifyAddress('172.16.0.1')).toBe('private')
    expect(classifyAddress('172.31.255.255')).toBe('private')
  })
  it('link-local incl. cloud metadata', () => {
    expect(classifyAddress('169.254.0.1')).toBe('link-local')
    expect(classifyAddress('169.254.169.254')).toBe('link-local') // AWS/GCP metadata
  })
  it('public addresses', () => {
    expect(classifyAddress('8.8.8.8')).toBe('public')
    expect(classifyAddress('172.32.0.1')).toBe('public')   // just outside 172.16/12
    expect(classifyAddress('192.169.0.1')).toBe('public')
  })
  it('unspecified', () => {
    expect(classifyAddress('0.0.0.0')).toBe('unspecified')
  })
})

describe('classifyAddress — IPv6 and mapped forms', () => {
  it('loopback / unspecified', () => {
    expect(classifyAddress('::1')).toBe('loopback')
    expect(classifyAddress('::')).toBe('unspecified')
  })
  it('link-local + unique-local', () => {
    expect(classifyAddress('fe80::1')).toBe('link-local')
    expect(classifyAddress('fd00::1')).toBe('unique-local')
    expect(classifyAddress('fc00::1')).toBe('unique-local')
  })
  it('IPv4-mapped-IPv6 classifies by the v4 tail (rebinding-evasion guard)', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback')
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('link-local')
    expect(classifyAddress('::ffff:8.8.8.8')).toBe('public')
  })
  it('public IPv6', () => {
    expect(classifyAddress('2606:4700:4700::1111')).toBe('public')
  })
  it('non-IP input returns null', () => {
    expect(classifyAddress('evil.com')).toBeNull()
    expect(classifyAddress('not-an-ip')).toBeNull()
  })
})

describe('isBlockedAddress — only internal classes pass', () => {
  it('allows loopback / private / unique-local', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(false)
    expect(isBlockedAddress('10.0.0.1')).toBe(false)
    expect(isBlockedAddress('fd00::1')).toBe(false)
  })
  it('blocks public, link-local (metadata), unspecified, and unparseable', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(true)
    expect(isBlockedAddress('169.254.169.254')).toBe(true) // metadata blocked
    expect(isBlockedAddress('0.0.0.0')).toBe(true)
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(true)
    expect(isBlockedAddress('garbage')).toBe(true)         // defensive default
  })
})

describe('precheckTargetUrl', () => {
  it('rejects non-http(s) protocols', () => {
    const r = precheckTargetUrl('file:///etc/passwd')
    expect(r.ok).toBe(false)
  })
  it('rejects invalid URL', () => {
    expect(precheckTargetUrl('::::').ok).toBe(false)
  })
  it('rejects a public IP literal up front (no DNS needed)', () => {
    const r = precheckTargetUrl('http://8.8.8.8/x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a private\/loopback/)
  })
  it('rejects the metadata IP literal', () => {
    expect(precheckTargetUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false)
  })
  it('accepts a private IP literal and connects to it directly', () => {
    const r = precheckTargetUrl('http://127.0.0.1:8080/health')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.ipLiteral).toBe('127.0.0.1'); expect(r.host).toBe('127.0.0.1') }
  })
  it('passes a hostname through (DNS resolution happens in the route)', () => {
    const r = precheckTargetUrl('http://evil.com/x')
    expect(r.ok).toBe(true)            // precheck alone can't reject — the route must DNS-resolve
    if (r.ok) { expect(r.ipLiteral).toBeNull(); expect(r.host).toBe('evil.com') }
  })
  it('classifies a bracketed IPv6 literal', () => {
    expect(precheckTargetUrl('http://[::1]:9000/').ok).toBe(true)
    expect(precheckTargetUrl('http://[2606:4700::1]/').ok).toBe(false)
  })
})
