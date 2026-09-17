// ABOUTME: Integration tests for CF Access auth on the admin middleware
// ABOUTME: A forged assertion must not grant admin access; a real one must

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import admin from './admin'
import { createExecutionContext } from '../db/test-helpers'

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const TEAM_DOMAIN = 'divinevideo.cloudflareaccess.com'
const AUD = 'names-admin-audience'
const ISSUER = `https://${TEAM_DOMAIN}`
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`
const KID = 'k1'
const ADMIN_URL = 'https://names.admin.divine.video/admin/reserved-words'

let signingKey: SigningKey

function baseEnv() {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    // A no-op D1 so a request that passes auth can reach the handler.
    DB: {
      prepare: () => ({
        bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    } as unknown as D1Database,
  }
}

beforeEach(async () => {
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  const pub = await exportJWK(pair.publicKey)
  const jwks = { keys: [{ ...pub, kid: KID, alg: 'RS256', use: 'sig' }] }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CERTS_URL) return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } })
    return new Response('not found', { status: 404 })
  }))
})

afterEach(() => vi.unstubAllGlobals())

function app() {
  const a = new Hono()
  a.route('/admin', admin)
  return a
}

function get(env: object, headers: Record<string, string>) {
  const req = new Request(ADMIN_URL, { headers })
  return app().fetch(req, env, createExecutionContext())
}

async function validToken(): Promise<string> {
  return new SignJWT({ email: 'admin@divine.video' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setExpirationTime('1h')
    .sign(signingKey)
}

describe('admin middleware CF Access auth', () => {
  it('refuses a forged Cf-Access-Jwt-Assertion instead of trusting its presence', async () => {
    const res = await get(baseEnv(), { 'Cf-Access-Jwt-Assertion': 'forged.jwt.value' })
    expect(res.status).toBe(401)
  })

  it('admits a validly-signed Access token', async () => {
    const res = await get(baseEnv(), { 'Cf-Access-Jwt-Assertion': await validToken() })
    expect(res.status).toBe(200)
  })
})
