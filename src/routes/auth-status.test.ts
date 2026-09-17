// ABOUTME: /api/admin/auth/status must verify a CF Access assertion, not trust it
// ABOUTME: A forged header reporting authenticated:true would make the SPA render the admin shell

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import authRoutes from './auth'

const TEAM_DOMAIN = 'divinevideo.cloudflareaccess.com'
const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`

const env = {
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: 'names-admin-audience',
} as never

// Empty JWKS: no key can verify anything, so any assertion is rejected. Enough
// to prove the endpoint verifies rather than trusts the header's presence.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CERTS_URL) return new Response(JSON.stringify({ keys: [] }), { headers: { 'content-type': 'application/json' } })
    return new Response('not found', { status: 404 })
  }))
})

afterEach(() => vi.unstubAllGlobals())

function status(headers: Record<string, string>) {
  const req = new Request('https://names.admin.divine.video/status', { headers })
  return authRoutes.fetch(req, env)
}

describe('GET /auth/status', () => {
  it('does not report authenticated for a forged Cf-Access-Jwt-Assertion', async () => {
    const res = await status({
      'Cf-Access-Jwt-Assertion': 'forged.jwt.value',
      'Cf-Access-Authenticated-User-Email': 'attacker@evil.test',
    })
    const json = await res.json() as { authenticated: boolean }
    expect(json.authenticated).toBe(false)
  })
})
