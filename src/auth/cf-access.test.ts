// ABOUTME: Tests for Cloudflare Access JWT verification
// ABOUTME: A token is trusted only when its signature, audience, issuer and expiry all check out

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { verifyAccessJwt, AccessValidationError } from './cf-access'

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const TEAM_DOMAIN = 'divinevideo.cloudflareaccess.com'
const AUD = 'test-audience-tag'
const ISSUER = `https://${TEAM_DOMAIN}`
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`
const KID = 'test-key-1'

const env = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD }

let signingKey: SigningKey
let otherKey: SigningKey
let jwks: { keys: unknown[] }

// Serve the real public key as the team's JWKS, so a token this suite signs
// verifies exactly as a Cloudflare-issued one would. Any other URL 404s, so a
// stray real network call fails loudly rather than silently passing.
beforeEach(async () => {
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  const pub = await exportJWK(pair.publicKey)
  jwks = { keys: [{ ...pub, kid: KID, alg: 'RS256', use: 'sig' }] }

  otherKey = (await generateKeyPair('RS256')).privateKey

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CERTS_URL) {
      return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function token(opts: {
  key?: SigningKey
  aud?: string
  iss?: string
  email?: string | undefined
  expSecondsFromNow?: number
  includeEmail?: boolean
} = {}): Promise<string> {
  const payload: Record<string, unknown> = {}
  if (opts.includeEmail !== false) payload.email = opts.email ?? 'admin@divine.video'
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(`${opts.expSecondsFromNow ?? 3600}s`)
    .sign(opts.key ?? signingKey)
}

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns the email from the verified claim', async () => {
    const jwt = await token({ email: 'real-admin@divine.video' })

    const result = await verifyAccessJwt(jwt, env)

    expect(result.email).toBe('real-admin@divine.video')
  })

  it('rejects a token signed by a key that is not in the team JWKS', async () => {
    // The forged-header case: an attacker mints their own token. Without
    // signature verification this would be accepted.
    const jwt = await token({ key: otherKey })

    await expect(verifyAccessJwt(jwt, env)).rejects.toBeInstanceOf(AccessValidationError)
  })

  it('rejects a token minted for a different Access application', async () => {
    const jwt = await token({ aud: 'some-other-apps-audience' })

    await expect(verifyAccessJwt(jwt, env)).rejects.toBeInstanceOf(AccessValidationError)
  })

  it('rejects a token from a different issuer', async () => {
    const jwt = await token({ iss: 'https://evil.cloudflareaccess.com' })

    await expect(verifyAccessJwt(jwt, env)).rejects.toBeInstanceOf(AccessValidationError)
  })

  it('rejects an expired token', async () => {
    const jwt = await token({ expSecondsFromNow: -60 })

    await expect(verifyAccessJwt(jwt, env)).rejects.toBeInstanceOf(AccessValidationError)
  })

  it('rejects a structurally malformed assertion rather than throwing', async () => {
    await expect(verifyAccessJwt('not.a.jwt', env)).rejects.toBeInstanceOf(AccessValidationError)
    await expect(verifyAccessJwt('', env)).rejects.toBeInstanceOf(AccessValidationError)
  })

  it('rejects a validly-signed token that carries no email claim', async () => {
    const jwt = await token({ includeEmail: false })

    await expect(verifyAccessJwt(jwt, env)).rejects.toThrow(/email/)
  })

  it('fails as an auth error, not a raw crash, when Access config is missing', async () => {
    // The middleware turns a non-AccessValidationError into a 500. If the vars
    // were ever absent this must still read as "not authenticated", not "server
    // broken", so the request can fall through to the other auth paths.
    const jwt = await token()

    await expect(verifyAccessJwt(jwt, {} as never)).rejects.toBeInstanceOf(AccessValidationError)
  })

  it('fails as an auth error, not a raw crash, when the team domain is malformed', async () => {
    // A present-but-invalid ACCESS_TEAM_DOMAIN must not throw a raw TypeError
    // from new URL(); the callers rethrow anything that is not an
    // AccessValidationError as a 500, which would lock out the fall-through path.
    const jwt = await token()

    await expect(
      verifyAccessJwt(jwt, { ACCESS_TEAM_DOMAIN: 'bad domain with spaces', ACCESS_AUD: AUD }),
    ).rejects.toBeInstanceOf(AccessValidationError)
  })
})
