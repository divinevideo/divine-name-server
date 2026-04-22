// ABOUTME: Keycast OAuth routes for admin authentication
// ABOUTME: PKCE flow with cookie-based sessions, mounted at /api/admin/auth

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
  startOAuthFlow,
  exchangeCodeForToken,
  getSession,
  deleteSession,
} from '../auth/keycast-oauth'

type Bindings = {
  SESSION_KV: KVNamespace
  KEYCAST_URL?: string
  KEYCAST_CLIENT_ID?: string
  OAUTH_CALLBACK_BASE_URL?: string
}

const auth = new Hono<{ Bindings: Bindings }>()

// Hostname guard only -- no CF Access or session check.
// Auth routes must be accessible to unauthenticated users.
auth.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  const isAdminHost = url.hostname === 'names.admin.divine.video' || url.hostname === 'admin.localhost'
  const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'admin.localhost'

  if (!isAdminHost && !isLocalDev) {
    return c.json({ ok: false, error: 'Unauthorized' }, 403)
  }

  await next()
})

/**
 * POST /api/admin/auth/start
 * Initiate Keycast OAuth PKCE flow. Returns the authorize URL.
 */
auth.post('/start', async (c) => {
  if (!c.env.KEYCAST_CLIENT_ID || !c.env.KEYCAST_URL) {
    return c.json({ error: 'OAuth not configured (KEYCAST_CLIENT_ID or KEYCAST_URL missing)' }, 503)
  }

  if (!c.env.SESSION_KV) {
    return c.json({ error: 'Session storage not configured' }, 503)
  }

  // OAUTH_CALLBACK_BASE_URL lets local dev override the callback origin because
  // Miniflare strips the port under `wrangler dev --host`. In production the
  // computed origin from c.req.url is correct and the override stays unset.
  const origin = c.env.OAUTH_CALLBACK_BASE_URL ?? new URL(c.req.url).origin
  const redirectUri = `${origin}/api/admin/auth/callback`

  const { authorizeUrl } = await startOAuthFlow(
    c.env.SESSION_KV,
    c.env.KEYCAST_URL,
    c.env.KEYCAST_CLIENT_ID,
    redirectUri,
  )

  return c.json({ authorize_url: authorizeUrl })
})

/**
 * GET /api/admin/auth/callback
 * OAuth callback. Exchanges code for token, sets session cookie, redirects to admin UI.
 */
auth.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return c.redirect('/?auth_error=' + encodeURIComponent(error))
  }

  if (!code || !state) {
    return c.redirect('/?auth_error=missing_params')
  }

  if (!c.env.KEYCAST_URL || !c.env.KEYCAST_CLIENT_ID || !c.env.SESSION_KV) {
    return c.redirect('/?auth_error=not_configured')
  }

  try {
    const { sessionId, session } = await exchangeCodeForToken(
      c.env.SESSION_KV,
      c.env.KEYCAST_URL,
      c.env.KEYCAST_CLIENT_ID,
      code,
      state,
    )

    // Cookie maxAge matches KV session TTL (both derived from token expiry).
    // Cap at 24 hours so sessions don't outlive a workday.
    const maxAge = Math.min(session.expires_at - Date.now(), 86400 * 1000) / 1000
    setCookie(c, '__session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: Math.floor(maxAge),
    })

    return c.redirect('/?auth_success=true')
  } catch (err) {
    console.error('OAuth token exchange failed:', err)
    return c.redirect('/?auth_error=token_exchange_failed')
  }
})

/**
 * GET /api/admin/auth/status
 * Check current session status.
 */
auth.get('/status', async (c) => {
  // Path 1: CF Access (edge-injected headers)
  const cfJwt = c.req.header('Cf-Access-Jwt-Assertion')
  if (cfJwt) {
    const email = c.req.header('Cf-Access-Authenticated-User-Email') || 'unknown'
    return c.json({ authenticated: true, email, pubkey: null, method: 'cf-access' })
  }

  // Path 2: Keycast session cookie
  if (!c.env.SESSION_KV) {
    return c.json({ authenticated: false })
  }

  const sessionId = getCookie(c, '__session')
  if (!sessionId) {
    return c.json({ authenticated: false })
  }

  const session = await getSession(c.env.SESSION_KV, sessionId)
  if (!session) {
    return c.json({ authenticated: false })
  }

  return c.json({
    authenticated: true,
    email: session.email,
    pubkey: session.pubkey,
    method: 'keycast',
  })
})

/**
 * POST /api/admin/auth/logout
 * Clear session and cookie.
 */
auth.post('/logout', async (c) => {
  const sessionId = getCookie(c, '__session')
  if (sessionId && c.env.SESSION_KV) {
    await deleteSession(c.env.SESSION_KV, sessionId)
  }

  deleteCookie(c, '__session', { path: '/' })

  return c.json({ ok: true })
})

export default auth
