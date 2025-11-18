// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import subdomain from './routes/subdomain'
import admin from './routes/admin'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

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

// Serve admin UI (must be after API routes to not interfere)
app.get('/admin/*', async (c) => {
  // For now, just return a placeholder
  // Will add proper static serving after build process is set up
  return c.json({ message: 'Admin UI coming soon' })
})

export default app
