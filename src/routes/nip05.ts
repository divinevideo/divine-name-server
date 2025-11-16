// ABOUTME: NIP-05 identity verification endpoints
// ABOUTME: Serves .well-known/nostr.json for root and subdomains

import { Hono } from 'hono'
import { getUsernameByName, getAllActiveUsernames } from '../db/queries'

type Bindings = {
  DB: D1Database
}

const nip05 = new Hono<{ Bindings: Bindings }>()

// Extract subdomain from hostname
function getSubdomain(hostname: string): string | null {
  const parts = hostname.split('.')
  if (parts.length >= 3 && parts[parts.length - 2] === 'divine' && parts[parts.length - 1] === 'video') {
    return parts[0]
  }
  return null
}

nip05.get('/.well-known/nostr.json', async (c) => {
  try {
    const hostname = new URL(c.req.url).hostname
    const subdomain = getSubdomain(hostname)

    if (subdomain) {
      // Subdomain NIP-05: return single user with "_" name
      const username = await getUsernameByName(c.env.DB, subdomain)

      if (!username || username.status !== 'active' || !username.pubkey) {
        return c.notFound()
      }

      const response: any = {
        names: {
          '_': username.pubkey
        }
      }

      // Add relays if present
      if (username.relays) {
        try {
          const relays = JSON.parse(username.relays)
          response.relays = {
            [username.pubkey]: relays
          }
        } catch {
          // Ignore invalid JSON
        }
      }

      return c.json(response, 200, {
        'Cache-Control': 'public, max-age=60'
      })

    } else {
      // Root domain NIP-05: return all active users
      const usernames = await getAllActiveUsernames(c.env.DB)

      const names: Record<string, string> = {}
      const relays: Record<string, string[]> = {}

      for (const username of usernames) {
        if (username.pubkey) {
          names[username.name] = username.pubkey

          if (username.relays) {
            try {
              const relayList = JSON.parse(username.relays)
              relays[username.pubkey] = relayList
            } catch {
              // Ignore invalid JSON
            }
          }
        }
      }

      const response: any = { names }
      if (Object.keys(relays).length > 0) {
        response.relays = relays
      }

      return c.json(response, 200, {
        'Cache-Control': 'public, max-age=60'
      })
    }

  } catch (error) {
    console.error('NIP-05 error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default nip05
