// ABOUTME: Tests for Keycast OAuth flow helpers
// ABOUTME: Covers PKCE start, code-for-token exchange, session storage, and UCAN parsing

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { base58 } from '@scure/base'
import {
  deleteSession,
  exchangeCodeForToken,
  extractEmailFromUcan,
  extractPubkeyFromUcan,
  generatePkceChallenge,
  getSession,
  OAUTH_STATE_PREFIX,
  OAUTH_STATE_TTL,
  SESSION_PREFIX,
  startOAuthFlow,
  type OAuthSession,
} from './keycast-oauth'

/** Encode a hex pubkey as a Keycast-shape did:key (secp256k1 multicodec + base58). */
function pubkeyToDidKey(hexPubkey: string): string {
  const pubkeyBytes = new Uint8Array(hexPubkey.match(/.{2}/g)!.map(b => parseInt(b, 16)))
  const bytes = new Uint8Array(34)
  bytes[0] = 0xe7
  bytes[1] = 0x01
  bytes.set(pubkeyBytes, 2)
  return `did:key:z${base58.encode(bytes)}`
}

/** Minimal in-memory KV double for tests. Honors put/get/delete; TTL is captured but not auto-expired. */
function createFakeKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>()
  const kv = {
    async get(key: string) {
      const entry = store.get(key)
      return entry ? entry.value : null
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: options?.expirationTtl })
    },
    async delete(key: string) {
      store.delete(key)
    },
    _store: store,
    _ttl(key: string): number | undefined {
      return store.get(key)?.expirationTtl
    },
  }
  return kv as KVNamespace & { _store: typeof store; _ttl: (k: string) => number | undefined }
}

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build a fake UCAN-shaped JWT. Signature segment is irrelevant for decoding. */
function buildUcan(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

const TEST_USER_PUBKEY = '97f5edd026071916a50012333a379c976896469d5e77061982721d51baea2f33'
const TEST_BUNKER_PUBKEY = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'

function buildTokenResponse(overrides: Partial<{
  access_token: string
  bunker_url: string
  expires_in: number
  refresh_token: string
}> = {}) {
  return {
    access_token: buildUcan({
      aud: pubkeyToDidKey(TEST_USER_PUBKEY),
      fct: [{ email: 'admin@divine.video', tenant_id: 1 }],
    }),
    bunker_url: `bunker://${TEST_BUNKER_PUBKEY}?relay=wss%3A%2F%2Frelay.example.com`,
    expires_in: 3600,
    ...overrides,
  }
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

describe('generatePkceChallenge', () => {
  it('produces a verifier and an S256 challenge derived from it', async () => {
    const { verifier, challenge } = await generatePkceChallenge()
    // Both must be URL-safe base64 (no +, /, =)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)

    // Challenge must equal base64url(sha256(verifier))
    const encoded = new TextEncoder().encode(verifier)
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    const bytes = new Uint8Array(digest)
    const expected = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })

  it('produces a fresh verifier per call', async () => {
    const a = await generatePkceChallenge()
    const b = await generatePkceChallenge()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('startOAuthFlow', () => {
  it('stores state with the configured TTL and returns an authorize URL with all required params', async () => {
    const kv = createFakeKv()
    const { authorizeUrl } = await startOAuthFlow(
      kv,
      'https://login.example.com',
      'test-client',
      'https://app.example.com/callback',
    )

    expect(authorizeUrl.startsWith('https://login.example.com/api/oauth/authorize?')).toBe(true)

    const params = new URL(authorizeUrl).searchParams
    expect(params.get('client_id')).toBe('test-client')
    expect(params.get('redirect_uri')).toBe('https://app.example.com/callback')
    expect(params.get('response_type')).toBe('code')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('scope')).toBe('policy:full')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)

    const state = params.get('state')
    expect(state).toBeTruthy()

    // State entry exists under the prefix with the OAuth state TTL, carrying the verifier + redirect
    const stateKey = OAUTH_STATE_PREFIX + state!
    expect(kv._ttl(stateKey)).toBe(OAUTH_STATE_TTL)
    const stored = JSON.parse((await kv.get(stateKey)) ?? 'null')
    expect(stored.redirect_uri).toBe('https://app.example.com/callback')
    expect(typeof stored.code_verifier).toBe('string')
    expect(stored.code_verifier.length).toBeGreaterThan(0)
  })

  it('uses a random state value per call', async () => {
    const kv = createFakeKv()
    const a = await startOAuthFlow(kv, 'https://k', 'c', 'https://r')
    const b = await startOAuthFlow(kv, 'https://k', 'c', 'https://r')
    const stateA = new URL(a.authorizeUrl).searchParams.get('state')
    const stateB = new URL(b.authorizeUrl).searchParams.get('state')
    expect(stateA).not.toBe(stateB)
  })
})

describe('exchangeCodeForToken', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function primeState(kv: KVNamespace, state: string, verifier = 'test-verifier', redirect = 'https://app.example.com/callback') {
    await kv.put(
      OAUTH_STATE_PREFIX + state,
      JSON.stringify({ code_verifier: verifier, redirect_uri: redirect }),
    )
  }

  it('posts the correct body to Keycast and returns a populated session', async () => {
    const kv = createFakeKv()
    await primeState(kv, 'the-state')

    const tokenBody = buildTokenResponse()
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(tokenBody), { status: 200 }))

    const { sessionId, session } = await exchangeCodeForToken(
      kv,
      'https://login.example.com',
      'test-client',
      'the-code',
      'the-state',
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchSpy.mock.calls[0]
    expect(calledUrl).toBe('https://login.example.com/api/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.example.com/callback',
      code_verifier: 'test-verifier',
      client_id: 'test-client',
    })

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/) // crypto.randomUUID
    expect(session.email).toBe('admin@divine.video')
    // pubkey must come from UCAN aud (user pubkey), not bunker_url (derived bunker pubkey)
    expect(session.pubkey).toBe(TEST_USER_PUBKEY)
    expect(session.pubkey).not.toBe(TEST_BUNKER_PUBKEY)
    expect(session.expires_at).toBeGreaterThan(Date.now())
    expect(session.expires_at).toBeLessThanOrEqual(Date.now() + 3600 * 1000)

    // Session persisted under SESSION_PREFIX with the KV TTL mirroring expires_in
    const storedRaw = await kv.get(SESSION_PREFIX + sessionId)
    expect(storedRaw).not.toBeNull()
    expect(JSON.parse(storedRaw!)).toMatchObject({ email: 'admin@divine.video' })
  })

  it('consumes state so it cannot be replayed', async () => {
    const kv = createFakeKv()
    await primeState(kv, 'single-use')
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(buildTokenResponse()), { status: 200 }))

    await exchangeCodeForToken(kv, 'https://k', 'c', 'code', 'single-use')

    await expect(
      exchangeCodeForToken(kv, 'https://k', 'c', 'code', 'single-use'),
    ).rejects.toThrow(/Invalid OAuth state/)
  })

  it('throws when state is missing', async () => {
    const kv = createFakeKv()
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(
      exchangeCodeForToken(kv, 'https://k', 'c', 'code', 'never-stored'),
    ).rejects.toThrow(/Invalid OAuth state/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws when the token endpoint returns a non-2xx response, including the upstream body', async () => {
    const kv = createFakeKv()
    await primeState(kv, 'bad')
    fetchSpy.mockResolvedValue(new Response('invalid_grant', { status: 400 }))

    await expect(
      exchangeCodeForToken(kv, 'https://k', 'c', 'code', 'bad'),
    ).rejects.toThrow(/Token exchange failed: 400 invalid_grant/)
  })

  it("falls back to 'keycast-user' when the UCAN carries no email", async () => {
    const kv = createFakeKv()
    await primeState(kv, 's')
    const tokenBody = buildTokenResponse({
      access_token: buildUcan({ fct: [{ tenant_id: 1 }] }),
    })
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(tokenBody), { status: 200 }))

    const { session } = await exchangeCodeForToken(kv, 'https://k', 'c', 'code', 's')
    expect(session.email).toBe('keycast-user')
  })

  it('sets pubkey to null when the UCAN aud is missing', async () => {
    const kv = createFakeKv()
    await primeState(kv, 's')
    const tokenBody = buildTokenResponse({
      access_token: buildUcan({ fct: [{ email: 'x@y' }] }),
    })
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(tokenBody), { status: 200 }))

    const { session } = await exchangeCodeForToken(kv, 'https://k', 'c', 'code', 's')
    expect(session.pubkey).toBeNull()
  })
})

describe('extractPubkeyFromUcan', () => {
  it('decodes a Keycast did:key aud to hex pubkey', () => {
    const token = buildUcan({ aud: pubkeyToDidKey(TEST_USER_PUBKEY) })
    expect(extractPubkeyFromUcan(token)).toBe(TEST_USER_PUBKEY)
  })

  it('returns null when aud is missing', () => {
    const token = buildUcan({ fct: [{ email: 'x@y' }] })
    expect(extractPubkeyFromUcan(token)).toBeNull()
  })

  it('returns null when aud is not a did:key', () => {
    const token = buildUcan({ aud: 'did:web:example.com' })
    expect(extractPubkeyFromUcan(token)).toBeNull()
  })

  it('returns null when the multicodec prefix is not secp256k1 (0xe7 0x01)', () => {
    // Build a did:key with an Ed25519 multicodec prefix (0xed 0x01) instead
    const bytes = new Uint8Array(34)
    bytes[0] = 0xed
    bytes[1] = 0x01
    bytes.set(new Uint8Array(32).fill(0xaa), 2)
    const token = buildUcan({ aud: `did:key:z${base58.encode(bytes)}` })
    expect(extractPubkeyFromUcan(token)).toBeNull()
  })

  it('returns null when the decoded payload is the wrong length', () => {
    // 33 bytes instead of 34 (missing one byte of the pubkey)
    const bytes = new Uint8Array(33)
    bytes[0] = 0xe7
    bytes[1] = 0x01
    const token = buildUcan({ aud: `did:key:z${base58.encode(bytes)}` })
    expect(extractPubkeyFromUcan(token)).toBeNull()
  })

  it('returns null when aud cannot be base58 decoded', () => {
    const token = buildUcan({ aud: 'did:key:z0OIl' }) // contains 0 and O which are not in base58 alphabet
    expect(extractPubkeyFromUcan(token)).toBeNull()
  })

  it('returns null on malformed tokens', () => {
    expect(extractPubkeyFromUcan(undefined)).toBeNull()
    expect(extractPubkeyFromUcan('')).toBeNull()
    expect(extractPubkeyFromUcan('one.bad.token')).toBeNull()
  })
})

describe('getSession / deleteSession', () => {
  it('returns the stored session when not expired', async () => {
    const kv = createFakeKv()
    const session: OAuthSession = {
      email: 'x@example.com',
      pubkey: 'a'.repeat(64),
      expires_at: Date.now() + 60_000,
    }
    await kv.put(SESSION_PREFIX + 'sid', JSON.stringify(session))

    const got = await getSession(kv, 'sid')
    expect(got).toEqual(session)
  })

  it('returns null when the session is missing', async () => {
    const kv = createFakeKv()
    expect(await getSession(kv, 'nope')).toBeNull()
  })

  it('returns null when expires_at is in the past', async () => {
    const kv = createFakeKv()
    const expired: OAuthSession = {
      email: 'x@example.com',
      pubkey: null,
      expires_at: Date.now() - 1_000,
    }
    await kv.put(SESSION_PREFIX + 'sid', JSON.stringify(expired))

    expect(await getSession(kv, 'sid')).toBeNull()
  })

  it('deleteSession removes the session', async () => {
    const kv = createFakeKv()
    const session: OAuthSession = {
      email: 'x@example.com',
      pubkey: null,
      expires_at: Date.now() + 60_000,
    }
    await kv.put(SESSION_PREFIX + 'sid', JSON.stringify(session))

    await deleteSession(kv, 'sid')
    expect(await kv.get(SESSION_PREFIX + 'sid')).toBeNull()
    expect(await getSession(kv, 'sid')).toBeNull()
  })
})
