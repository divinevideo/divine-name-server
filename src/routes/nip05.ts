// ABOUTME: NIP-05 identity verification endpoints
// ABOUTME: Serves .well-known/nostr.json for root and subdomains

import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'
import { getSubdomain } from '../utils/subdomain'

type Bindings = {
  DB: D1Database
}

const nip05 = new Hono<{ Bindings: Bindings }>()

nip05.get('/.well-known/nostr.json', async (c) => {
  try {
    const hostname = new URL(c.req.url).hostname
    const subdomain = getSubdomain(hostname)

    if (subdomain) {
      // Subdomain NIP-05: return single user with "_" name
      // Normalize subdomain to lowercase for canonical lookup
      const canonicalSubdomain = subdomain.toLowerCase()
      const username = await getUsernameByName(c.env.DB, canonicalSubdomain)

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
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      })

    } else {
      // Root domain NIP-05: require name parameter for scalability
      const name = c.req.query('name')

      if (!name) {
        return c.json({ error: 'Name is required.' }, 400, {
          'Access-Control-Allow-Origin': '*'
        })
      }

      // Query specific user by name (normalize to lowercase for canonical lookup)
      const canonicalName = name.toLowerCase()
      const username = await getUsernameByName(c.env.DB, canonicalName)

      if (!username || username.status !== 'active' || !username.pubkey) {
        return c.json({ names: {} }, 200, {
          'Cache-Control': 'public, max-age=60',
          'Access-Control-Allow-Origin': '*'
        })
      }

      // Use display name if available, otherwise fall back to canonical/name
      const displayName = username.username_display || username.name || canonicalName
      const response: any = {
        names: {
          [displayName]: username.pubkey
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
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      })
    }

  } catch (error) {
    console.error('NIP-05 error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default nip05
