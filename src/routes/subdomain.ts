// ABOUTME: Subdomain profile routing middleware
// ABOUTME: Proxies username.divine.video to main app's profile page

import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'
import { bech32 } from '@scure/base'

type Bindings = {
  DB: D1Database
}

const subdomain = new Hono<{ Bindings: Bindings }>()

function getSubdomain(hostname: string): string | null {
  const parts = hostname.split('.')
  if (parts.length >= 3 && parts[parts.length - 2] === 'divine' && parts[parts.length - 1] === 'video') {
    return parts[0]
  }
  return null
}

function hexToNpub(hex: string): string {
  const data = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    data[i] = parseInt(hex.substr(i * 2, 2), 16)
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
