// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import subdomain from './routes/subdomain'
import admin from './routes/admin'
import publicRoutes from './routes/public'
import { getAllActiveUsernames, expireStaleReservations } from './db/queries'
import { bulkSyncToFastly } from './utils/fastly-sync'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
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

// Service info fallback for non-public hostnames
app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

// Admin API (protected by Cloudflare Access)
app.route('/api/admin', admin)

// NIP-05
app.route('', nip05)

// Admin UI SPA fallback - serve index.html for non-API routes on admin subdomain
app.get('*', async (c) => {
  const url = new URL(c.req.url)

  // Only handle admin subdomain SPA routes
  if (url.hostname === 'names.admin.divine.video') {
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

    // Hourly reconciliation: sync all active D1 users to Fastly KV
    if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) return

    const activeUsers = await getAllActiveUsernames(env.DB)
    const toSync = activeUsers
      .filter(u => u.pubkey)
      .map(u => ({
        username: u.username_canonical || u.name,
        data: {
          pubkey: u.pubkey!,
          relays: u.relays ? (() => { try { return JSON.parse(u.relays!) } catch { return [] } })() : [],
          status: 'active' as const
        }
      }))

    const results = await bulkSyncToFastly(env, toSync)
    console.log(`Cron sync: ${results.success} synced, ${results.failed} failed out of ${toSync.length} active users`)
  }
}
