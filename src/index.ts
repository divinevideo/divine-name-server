// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import webfinger from './routes/webfinger'
import subdomain from './routes/subdomain'
import admin from './routes/admin'
// Auth routes are mounted inside admin.ts (same Hono app, exempt from auth middleware)
import publicRoutes from './routes/public'
import internalAtproto from './routes/internal-atproto'
import internalDeletion from './routes/internal-deletion'
import { getUsernamesUpdatedSince, expireStaleReservations, getQueuedFastlySyncTasks, enqueueFastlySyncTask, clearFastlySyncTasks, markFastlySyncTaskFailures, getStaleReleaseAttempts, rollbackReleaseAttempt } from './db/queries'
import { syncBatch, parseRelayHints, type UsernameKVData } from './utils/fastly-sync'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  SESSION_KV?: KVNamespace
  ADMIN_PUBKEYS?: string
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
  ATPROTO_SYNC_TOKEN?: string
  DELETION_COORDINATOR_TOKEN?: string
  KEYCAST_URL?: string
  KEYCAST_CLIENT_ID?: string
  AP_ACTOR_BASE_URL?: string
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
app.route('/api/internal', internalDeletion)

// NIP-05
app.route('', nip05)

// ActivityPub discovery: WebFinger + NodeInfo (read-only over usernames table)
app.route('', webfinger)

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

    const staleReleaseAttempts = await getStaleReleaseAttempts(env.DB)
    let restoredReleaseAttempts = 0
    for (const attempt of staleReleaseAttempts) {
      const result = await rollbackReleaseAttempt(
        env.DB,
        attempt.pubkey,
        attempt.username_canonical,
        attempt.attempt_id,
        'expired-restored'
      )
      if (result.outcome === 'transitioned' || result.outcome === 'replayed') restoredReleaseAttempts += 1
    }
    if (restoredReleaseAttempts > 0) {
      console.log(`Cron: restored ${restoredReleaseAttempts} expired username release attempts`)
    }

    // Six-hour overlap covers delayed cron firings while the durable queue
    // preserves retries for anything that still fails after bounded Fastly retries.
    const sixHoursAgo = Math.floor(Date.now() / 1000) - (6 * 60 * 60)
    const recentlyChanged = await getUsernamesUpdatedSince(env.DB, sixHoursAgo)
    const queuedTasks = await getQueuedFastlySyncTasks(env.DB, 5000)

    const itemsByUsername = new Map<string, {
      username: string
      action: 'sync' | 'delete'
      data?: UsernameKVData
    }>()

    for (const task of queuedTasks) {
      itemsByUsername.set(task.username, task)
    }

    for (const user of recentlyChanged) {
      if (user.status === 'active' && user.pubkey) {
        itemsByUsername.set(user.username_canonical || user.name, {
          username: user.username_canonical || user.name,
          action: 'sync',
          data: {
            pubkey: user.pubkey,
            relays: parseRelayHints(user.relays),
            status: 'active',
            atproto_did: user.atproto_did,
            atproto_state: user.atproto_state,
          },
        })
      } else if (user.status === 'revoked' || user.status === 'burned' || user.status === 'pending-release') {
        itemsByUsername.set(user.username_canonical || user.name, {
          username: user.username_canonical || user.name,
          action: 'delete',
        })
      }
    }

    const items = Array.from(itemsByUsername.values())
    const results = await syncBatch(env, items, { concurrency: 10 })
    const queuedByUsername = new Map(queuedTasks.map(task => [task.username, task]))
    const completedQueuedTasks = results.successes.flatMap(result => {
      const queued = queuedByUsername.get(result.username)
      const attempted = itemsByUsername.get(result.username)
      if (!queued || !attempted) return []
      const sameAction = queued.action === attempted.action
      const samePayload = JSON.stringify(queued.data || null) === JSON.stringify(attempted.data || null)
      return sameAction && samePayload ? [{ username: queued.username, generation: queued.generation }] : []
    })
    await clearFastlySyncTasks(env.DB, completedQueuedTasks)
    for (const failure of results.failures) {
      const item = itemsByUsername.get(failure.username)
      if (item) {
        await enqueueFastlySyncTask(env.DB, item)
      }
    }
    await markFastlySyncTaskFailures(
      env.DB,
      results.failures.map(result => ({ username: result.username, error: result.error }))
    )

    console.log(`Cron Fastly reconciliation: ${recentlyChanged.length} recent changes, ${queuedTasks.length} queued, ${results.synced} synced, ${results.deleted} deleted, ${results.failed} failed`)
  }
}
