// ABOUTME: Subdomain profile routing middleware
// ABOUTME: Proxies username.divine.video to main app's profile page

import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'
import { bech32 } from '@scure/base'
import { getSubdomain } from '../utils/subdomain'

type Bindings = {
  DB: D1Database
}

const subdomain = new Hono<{ Bindings: Bindings }>()

function hexToNpub(hex: string): string {
  // Validate hex string length
  if (hex.length !== 64) {
    throw new Error(`Invalid hex string length: expected 64 characters, got ${hex.length}`)
  }

  // Validate hex string contains only valid hex characters
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hexadecimal characters')
  }

  const data = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    data[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  const words = bech32.toWords(data)
  return bech32.encode('npub', words)
}

subdomain.get('/', async (c) => {
  const hostname = new URL(c.req.url).hostname
  const subdomainName = getSubdomain(hostname)

  if (!subdomainName) {
    // Not a subdomain, pass through
    return c.notFound()
  }

  try {
    // Look up username
    const username = await getUsernameByName(c.env.DB, subdomainName)

    if (!username || username.status !== 'active' || !username.pubkey) {
      return c.html(`
        <html>
          <head><title>User Not Found</title></head>
          <body>
            <h1>Username @${subdomainName}.divine.video not found</h1>
            <p>This username is not currently active.</p>
          </body>
        </html>
      `, 404)
    }

    // Convert pubkey to npub
    const npub = hexToNpub(username.pubkey)

    // Proxy to main app
    const mainAppUrl = `https://divine.video/profile/${npub}`
    const response = await fetch(mainAppUrl)

    // Return the response
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    })

  } catch (error) {
    console.error('Subdomain routing error:', error)
    return c.html('<h1>Error loading profile</h1>', 500)
  }
})

export default subdomain
