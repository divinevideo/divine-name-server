// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import subdomain from './routes/subdomain'
import admin from './routes/admin'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
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

// Admin UI static files are served automatically via [assets] config in wrangler.toml
// The assets middleware handles all static file serving including SPA routing

export default app
