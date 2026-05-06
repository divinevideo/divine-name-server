// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import subdomain from './routes/subdomain'
import admin from './routes/admin'
// Auth routes are mounted inside admin.ts (same Hono app, exempt from auth middleware)
import publicRoutes from './routes/public'
import internalAtproto from './routes/internal-atproto'
import { getUsernamesUpdatedSince, expireStaleReservations } from './db/queries'
import { syncBatch, parseRelayHints } from './utils/fastly-sync'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  SESSION_KV?: KVNamespace
  ADMIN_PUBKEYS?: string
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
  ATPROTO_SYNC_TOKEN?: string
  KEYCAST_URL?: string
  KEYCAST_CLIENT_ID?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Pass through app deep linking files to static assets (served by Pages)
// These files are not handled by this worker - let them fall through to origin
app.get('/.well-known/assetlinks.json', (c) => {
  return fetch(c.req.raw)
})
app.get('/.well-known/apple-app-site-association', (c) => {
  return fetch(c.req.raw)
})

// Subdomain profile routing (must be first to catch subdomains)
app.route('', subdomain)

// Public UI for names.divine.video (hostname-guarded)
app.route('', publicRoutes)

// Service info fallback for non-public, non-admin hostnames
app.use('/', async (c, next) => {
  const hostname = new URL(c.req.url).hostname
  if (hostname === 'names.admin.divine.video' || hostname === 'admin.localhost') {
    return next() // Let admin SPA catch-all handle it
  }
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

// Admin API (protected by Cloudflare Access or Keycast session)
// Auth routes are mounted inside admin.ts, exempted from auth check
app.route('/api/admin', admin)

// Internal service API (service-authenticated bearer token)
app.route('/api/internal', internalAtproto)

// NIP-05
app.route('', nip05)

// Admin UI SPA fallback - serve index.html for non-API routes on admin subdomain
app.get('*', async (c) => {
  const url = new URL(c.req.url)

  // Only handle admin subdomain SPA routes (plus admin.localhost for local dev)
  if (url.hostname === 'names.admin.divine.video' || url.hostname === 'admin.localhost') {
    // Don't intercept API routes
    if (url.pathname.startsWith('/api/')) {
      return c.notFound()
    }

    // Try to serve static asset first
    try {
      const assetUrl = new URL(c.req.url)
      const response = await c.env.ASSETS.fetch(assetUrl)
      if (response.status !== 404) {
        return response
      }
    } catch {
      // Asset not found, fall through to index.html
    }

    // SPA fallback - serve index.html for client-side routing
    const indexUrl = new URL('/', c.req.url)
    return c.env.ASSETS.fetch(indexUrl)
  }

  return c.notFound()
})

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    // Expire unconfirmed reservations older than 48 hours
    const expired = await expireStaleReservations(env.DB)
    if (expired > 0) {
      console.log(`Cron: expired ${expired} stale pending-confirmation reservations`)
    }

    // Delta sync: only sync usernames updated in the last 2 hours (overlap for safety)
    const twoHoursAgo = Math.floor(Date.now() / 1000) - (2 * 60 * 60)
    const recentlyChanged = await getUsernamesUpdatedSince(env.DB, twoHoursAgo)

    const items = recentlyChanged
      .filter(u => (u.status === 'active' && u.pubkey) || u.status === 'revoked' || u.status === 'burned')
      .map(u => ({
        username: u.username_canonical || u.name,
        action: (u.status === 'active' ? 'sync' : 'delete') as 'sync' | 'delete',
        data: u.status === 'active' ? {
          pubkey: u.pubkey!,
          relays: parseRelayHints(u.relays),
          status: 'active' as const,
          atproto_did: u.atproto_did,
          atproto_state: u.atproto_state,
        } : undefined,
      }))

    const results = await syncBatch(env, items, { concurrency: 10 })
    console.log(`Cron delta sync: ${recentlyChanged.length} changed, ${results.synced} synced, ${results.deleted} deleted, ${results.failed} failed`)
  }
}
