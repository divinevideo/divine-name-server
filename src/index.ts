// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

// NIP-05
app.route('', nip05)

export default app
