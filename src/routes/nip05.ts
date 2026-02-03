// ABOUTME: NIP-05 identity verification endpoints
// ABOUTME: Serves .well-known/nostr.json for root and subdomains

import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'
import { getSubdomain } from '../utils/subdomain'
import { validateUsername } from '../utils/validation'

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
      // Convert subdomain to canonical form (handles Unicode → punycode)
      let canonicalSubdomain: string
      try {
        const validated = validateUsername(subdomain)
        canonicalSubdomain = validated.canonical
      } catch {
        return c.notFound()
      }
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

      // Convert name to canonical form (handles Unicode → punycode)
      let canonicalName: string
      try {
        const validated = validateUsername(name)
        canonicalName = validated.canonical
      } catch {
        // Invalid username format - return empty result
        return c.json({ names: {} }, 200, {
          'Cache-Control': 'public, max-age=60',
          'Access-Control-Allow-Origin': '*'
        })
      }
      const username = await getUsernameByName(c.env.DB, canonicalName)

      if (!username || username.status !== 'active' || !username.pubkey) {
        return c.json({ names: {} }, 200, {
          'Cache-Control': 'public, max-age=60',
          'Access-Control-Allow-Origin': '*'
        })
      }

      // Use the queried name in response (preserves what client asked for)
      // This ensures clients that query with punycode get punycode back,
      // and clients that query with Unicode get Unicode back
      const responseName = name.trim()
      const response: any = {
        names: {
          [responseName]: username.pubkey
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
