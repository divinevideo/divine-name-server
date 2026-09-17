// ABOUTME: Integration tests for CF Access auth on the admin middleware
// ABOUTME: A forged assertion must not grant admin access; a real one must

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
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
let jwks: { keys: unknown[] }

function baseEnv(db?: D1Database) {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    // A no-op D1 so a request that passes auth can reach the handler.
    DB: db ?? ({
      prepare: () => ({
        bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    } as unknown as D1Database),
  }
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  const pub = await exportJWK(pair.publicKey)
  jwks = { keys: [{ ...pub, kid: KID, alg: 'RS256', use: 'sig' }] }
})

beforeEach(() => {
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

async function validToken(email = 'admin@divine.video'): Promise<string> {
  return new SignJWT({ email })
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

  it('uses the verified claim, not the separate email header, for audit identity', async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const result = {
      run: async () => ({ success: true }),
      first: async () => null,
      all: async () => ({ results: [] }),
    }
    const db = {
      prepare(sql: string) {
        return {
          bind: (...params: unknown[]) => {
            calls.push({ sql, params })
            return result
          },
          ...result,
        }
      },
    } as unknown as D1Database
    const req = new Request('https://names.admin.divine.video/admin/username/reserve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cf-Access-Jwt-Assertion': await validToken('verified@divine.video'),
        'Cf-Access-Authenticated-User-Email': 'attacker@evil.test',
      },
      body: JSON.stringify({ name: 'claim-wins', reason: 'test' }),
    })

    const res = await app().fetch(req, baseEnv(db), createExecutionContext())

    expect(res.status).toBe(200)
    const insert = calls.find(call => call.sql.includes('INSERT INTO usernames'))
    expect(insert?.params[5]).toBe('verified@divine.video')
    expect(insert?.params).not.toContain('attacker@evil.test')
  })
})
