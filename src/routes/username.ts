// ABOUTME: Username claiming endpoint with NIP-98 authentication
// ABOUTME: Handles POST /api/username/claim for users to claim usernames

import { Hono } from 'hono'
import { verifyNip98Event } from '../middleware/nip98'
import { validateUsername, validateRelays, UsernameValidationError, RelayValidationError } from '../utils/validation'
import {
  isReservedWord,
  getUsernameByName,
  getUsernameByPubkey,
  claimUsername
} from '../db/queries'

type Bindings = {
  DB: D1Database
}

const username = new Hono<{ Bindings: Bindings }>()

username.post('/claim', async (c) => {
  try {
    // Read raw body text first (needed for NIP-98 payload verification)
    const bodyText = await c.req.text()

    // Verify NIP-98 authentication with payload
    const url = new URL(c.req.url)
    const pubkey = await verifyNip98Event(
      c.req.raw.headers,
      'POST',
      url.toString(),
      bodyText
    )

    // Parse request body
    const body = JSON.parse(bodyText) as { name: string; relays?: string[] }
    const { name, relays = null } = body

    // Validate username format
    try {
      validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    // Validate relays if provided
    if (relays !== null) {
      try {
        validateRelays(relays)
      } catch (error) {
        if (error instanceof RelayValidationError) {
          return c.json({ ok: false, error: error.message }, 400)
        }
        throw error
      }
    }

    // Check if name is reserved
    const reserved = await isReservedWord(c.env.DB, name)
    if (reserved) {
      return c.json({ ok: false, error: 'Username is reserved' }, 403)
    }

    // Check if name exists
    const existing = await getUsernameByName(c.env.DB, name)
    if (existing) {
      if (existing.status === 'active' && existing.pubkey !== pubkey) {
        return c.json({ ok: false, error: 'Username already claimed' }, 409)
      }
      if (existing.status === 'reserved') {
        return c.json({ ok: false, error: 'Username is reserved' }, 403)
      }
      if (existing.status === 'burned') {
        return c.json({ ok: false, error: 'Username is permanently unavailable' }, 403)
      }
      // If revoked and recyclable, allow claim (continue below)
    }

    // Check if pubkey already has an active username
    const currentUsername = await getUsernameByPubkey(c.env.DB, pubkey)
    if (currentUsername && currentUsername.name !== name) {
      // User is claiming a new username, old one will be auto-revoked
    }

    // Claim the username
    await claimUsername(c.env.DB, name, pubkey, relays)

    // Return success response
    return c.json({
      ok: true,
      name,
      pubkey,
      profile_url: `https://${name}.divine.video/`,
      nip05: {
        main_domain: `${name}@divine.video`,
        underscore_subdomain: `_@${name}.divine.video`,
        host_style: `@${name}.divine.video`
      }
    })

  } catch (error) {
    if (error instanceof Error && error.name === 'Nip98Error') {
      return c.json({ ok: false, error: error.message }, 401)
    }
    console.error('Claim error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default username
