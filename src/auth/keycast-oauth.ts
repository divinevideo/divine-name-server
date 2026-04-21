// ABOUTME: Keycast OAuth PKCE flow for admin authentication
// ABOUTME: Session-ID-based sessions stored in KV, consumed via HTTP-only cookie

export const OAUTH_STATE_PREFIX = 'nameserver:oauth-state:'
export const SESSION_PREFIX = 'nameserver:session:'
export const OAUTH_STATE_TTL = 300 // 5 minutes

export interface OAuthSession {
  email: string
  pubkey: string | null
  expires_at: number
}

/**
 * Generate PKCE code_verifier and code_challenge (S256).
 */
export async function generatePkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  const verifier = base64UrlEncode(array)

  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const challenge = base64UrlEncode(new Uint8Array(digest))

  return { verifier, challenge }
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = ''
  for (const byte of buffer) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Start the OAuth flow: generate PKCE, store state in KV, return authorize URL.
 */
export async function startOAuthFlow(
  kv: KVNamespace,
  keycastUrl: string,
  clientId: string,
  redirectUri: string,
): Promise<{ authorizeUrl: string }> {
  const { verifier, challenge } = await generatePkceChallenge()
  const state = crypto.randomUUID()

  await kv.put(
    OAUTH_STATE_PREFIX + state,
    JSON.stringify({ code_verifier: verifier, redirect_uri: redirectUri }),
    { expirationTtl: OAUTH_STATE_TTL },
  )

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'policy:full',
    state,
  })

  return { authorizeUrl: `${keycastUrl}/api/oauth/authorize?${params.toString()}` }
}

/**
 * Exchange authorization code for token and create session.
 * Returns the session ID to set as a cookie.
 */
export async function exchangeCodeForToken(
  kv: KVNamespace,
  keycastUrl: string,
  clientId: string,
  code: string,
  state: string,
): Promise<{ sessionId: string; session: OAuthSession }> {
  // Retrieve and consume state
  const stateKey = OAUTH_STATE_PREFIX + state
  const stateData = await kv.get(stateKey)
  if (!stateData) {
    throw new Error('Invalid OAuth state -- expired or already used')
  }
  await kv.delete(stateKey)

  const { code_verifier, redirect_uri } = JSON.parse(stateData) as {
    code_verifier: string
    redirect_uri: string
  }

  // Exchange code for token
  const resp = await fetch(`${keycastUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      code_verifier,
      client_id: clientId,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Token exchange failed: ${resp.status} ${body}`)
  }

  const tokenData = await resp.json() as {
    access_token?: string
    bunker_url: string
    expires_in: number
    refresh_token?: string
  }

  // Extract identity from the response
  const pubkey = extractPubkeyFromBunkerUrl(tokenData.bunker_url)
  const email = extractEmailFromUcan(tokenData.access_token) || 'keycast-user'

  const session: OAuthSession = {
    email,
    pubkey,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  }

  // Store session keyed by random ID
  const sessionId = crypto.randomUUID()
  await kv.put(
    SESSION_PREFIX + sessionId,
    JSON.stringify(session),
    { expirationTtl: tokenData.expires_in },
  )

  return { sessionId, session }
}

/**
 * Get session by ID. Returns null if expired or missing.
 */
export async function getSession(
  kv: KVNamespace,
  sessionId: string,
): Promise<OAuthSession | null> {
  const raw = await kv.get(SESSION_PREFIX + sessionId)
  if (!raw) return null

  const session = JSON.parse(raw) as OAuthSession
  if (session.expires_at <= Date.now()) return null

  return session
}

/**
 * Delete session (logout).
 */
export async function deleteSession(
  kv: KVNamespace,
  sessionId: string,
): Promise<void> {
  await kv.delete(SESSION_PREFIX + sessionId)
}

/**
 * Extract pubkey from bunker URL: bunker://{hex-pubkey}?relay=...
 */
function extractPubkeyFromBunkerUrl(bunkerUrl: string): string | null {
  try {
    const match = bunkerUrl.match(/^bunker:\/\/([0-9a-f]{64})/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Extract email from a Keycast UCAN access token.
 *
 * Keycast UCANs (see keycast api/src/api/http/auth.rs::generate_server_signed_ucan)
 * place email inside the UCAN facts array (`fct`) per the UCAN 0.10 spec, not as a
 * top-level JWT claim. Decoding as `payload.email` misses it and every Keycast-authed
 * admin falls through to the generic fallback in exchangeCodeForToken().
 */
export function extractEmailFromUcan(token: string | undefined): string | null {
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    const facts = Array.isArray(payload.fct) ? payload.fct : []
    for (const fact of facts) {
      if (fact && typeof fact.email === 'string' && fact.email.length > 0) {
        return fact.email
      }
    }
    return null
  } catch {
    return null
  }
}
