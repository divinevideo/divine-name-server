// ABOUTME: Tests for Keycast UCAN access-token helpers
// ABOUTME: Pins UCAN fact-array shape so Keycast-authed admins keep a real email

import { describe, it, expect } from 'vitest'
import { extractEmailFromUcan } from './keycast-oauth'

/** Build a fake UCAN-shaped JWT. Signature segment is irrelevant for decoding. */
function buildUcan(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('extractEmailFromUcan', () => {
  it('returns email from the UCAN fct array (Keycast shape)', () => {
    const token = buildUcan({
      iss: 'did:key:server',
      aud: 'did:key:user',
      fct: [
        {
          tenant_id: 1,
          email: 'admin@divine.video',
          redirect_origin: 'https://names.admin.divine.video',
        },
      ],
    })
    expect(extractEmailFromUcan(token)).toBe('admin@divine.video')
  })

  it('returns email from the first fact that has one when multiple facts are present', () => {
    const token = buildUcan({
      fct: [
        { tenant_id: 1 },
        { email: 'first@example.com' },
        { email: 'second@example.com' },
      ],
    })
    expect(extractEmailFromUcan(token)).toBe('first@example.com')
  })

  it('returns null when fct is absent', () => {
    const token = buildUcan({ iss: 'did:key:server' })
    expect(extractEmailFromUcan(token)).toBeNull()
  })

  it('returns null when fct is not an array', () => {
    const token = buildUcan({ fct: { email: 'nope@example.com' } })
    expect(extractEmailFromUcan(token)).toBeNull()
  })

  it('returns null when no fact carries an email', () => {
    const token = buildUcan({ fct: [{ tenant_id: 1 }, { redirect_origin: 'x' }] })
    expect(extractEmailFromUcan(token)).toBeNull()
  })

  it('skips empty-string email values', () => {
    const token = buildUcan({ fct: [{ email: '' }, { email: 'real@example.com' }] })
    expect(extractEmailFromUcan(token)).toBe('real@example.com')
  })

  it('does NOT read a top-level payload.email claim (old buggy behavior)', () => {
    // Guard against regression to the previous implementation that looked at
    // payload.email / payload.sub_email. Keycast never emits those.
    const token = buildUcan({ email: 'top-level@example.com', sub_email: 'sub@example.com' })
    expect(extractEmailFromUcan(token)).toBeNull()
  })

  it('returns null on undefined or malformed tokens', () => {
    expect(extractEmailFromUcan(undefined)).toBeNull()
    expect(extractEmailFromUcan('')).toBeNull()
    expect(extractEmailFromUcan('not-a-jwt')).toBeNull()
    expect(extractEmailFromUcan('one')).toBeNull()
    expect(extractEmailFromUcan('header.not-base64-json.sig')).toBeNull()
  })

  it('handles URL-safe base64 padding variants', () => {
    // Payload with chars that force + / = in standard base64 before URL-safe substitution
    const token = buildUcan({ fct: [{ email: 'pädding+test@example.com' }] })
    expect(extractEmailFromUcan(token)).toBe('pädding+test@example.com')
  })
})
