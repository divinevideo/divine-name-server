// ABOUTME: Username API endpoints for claiming and checking usernames
// ABOUTME: Public endpoints: GET /check/:name, GET /by-pubkey/:pubkey
// ABOUTME: Authenticated: POST /claim (NIP-98 auth - works for both custodial and non-custodial users)

import { Hono } from 'hono'
import { verifyNip98Event } from '../middleware/nip98'
import { validateUsername, validateRelays, UsernameValidationError, RelayValidationError } from '../utils/validation'
import {
  isReservedWord,
  getUsernameByName,
  getUsernameByPubkey,
  claimUsername
} from '../db/queries'
import { syncUsernameToFastly } from '../utils/fastly-sync'

type Bindings = {
  DB: D1Database
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
}

const username = new Hono<{ Bindings: Bindings }>()

// Public endpoint: check username availability (no auth required)
// Used by Flutter app and web clients before attempting to claim
username.get('/check/:name', async (c) => {
  try {
    const name = c.req.param('name')

    // Validate username format
    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({
          ok: true,
          available: false,
          name,
          reason: error.message
        }, 200, { 'Access-Control-Allow-Origin': '*' })
      }
      throw error
    }

    // Check if reserved word
    const reserved = await isReservedWord(c.env.DB, usernameData.canonical)
    if (reserved) {
      return c.json({
        ok: true,
        available: false,
        name: usernameData.display,
        canonical: usernameData.canonical,
        reason: 'Username is reserved'
      }, 200, { 'Access-Control-Allow-Origin': '*' })
    }

    // Check if already exists
    const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
    if (existing) {
      const reason = existing.status === 'active'
        ? 'Username is already taken'
        : existing.status === 'reserved'
        ? 'Username is reserved'
        : existing.status === 'burned'
        ? 'Username is permanently unavailable'
        : 'Username is unavailable'

      return c.json({
        ok: true,
        available: existing.status === 'revoked', // Revoked usernames can be recycled
        name: usernameData.display,
        canonical: usernameData.canonical,
        status: existing.status,
        reason: existing.status === 'revoked' ? undefined : reason
      }, 200, { 'Access-Control-Allow-Origin': '*' })
    }

    // Username is available
    return c.json({
      ok: true,
      available: true,
      name: usernameData.display,
      canonical: usernameData.canonical
    }, 200, { 'Access-Control-Allow-Origin': '*' })

  } catch (error) {
    console.error('Check error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

// Public endpoint: get username details by pubkey (no auth required)
// Useful for checking if a pubkey already has a username
username.get('/by-pubkey/:pubkey', async (c) => {
  try {
    const pubkey = c.req.param('pubkey')

    // Basic hex validation
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      return c.json({
        ok: false,
        error: 'Invalid pubkey format (expected 64 hex characters)'
      }, 400, { 'Access-Control-Allow-Origin': '*' })
    }

    const existing = await getUsernameByPubkey(c.env.DB, pubkey.toLowerCase())

    if (!existing) {
      return c.json({
        ok: true,
        found: false
      }, 200, { 'Access-Control-Allow-Origin': '*' })
    }

    return c.json({
      ok: true,
      found: true,
      name: existing.username_display || existing.name,
      canonical: existing.username_canonical || existing.name?.toLowerCase(),
      pubkey: existing.pubkey,
      profile_url: `https://${existing.username_canonical || existing.name?.toLowerCase()}.divine.video/`,
      nip05: {
        main_domain: `${existing.username_canonical || existing.name?.toLowerCase()}@divine.video`,
        underscore_subdomain: `_@${existing.username_canonical || existing.name?.toLowerCase()}.divine.video`,
        host_style: `@${existing.username_canonical || existing.name?.toLowerCase()}.divine.video`
      }
    }, 200, { 'Access-Control-Allow-Origin': '*' })

  } catch (error) {
    console.error('By-pubkey error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

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

    // Validate username format and get canonical version
    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    const { display: nameDisplay, canonical: nameCanonical } = usernameData

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

    // Check if name is reserved (check canonical)
    const reserved = await isReservedWord(c.env.DB, nameCanonical)
    if (reserved) {
      return c.json({ ok: false, error: 'Username is reserved' }, 403)
    }

    // Check if name exists (using canonical for lookup)
    const existing = await getUsernameByName(c.env.DB, nameCanonical)
    if (existing) {
      if (existing.status === 'active' && existing.pubkey !== pubkey) {
        return c.json({ ok: false, error: 'That username is already taken' }, 409)
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
    if (currentUsername) {
      const currentCanonical = currentUsername.username_canonical || currentUsername.name?.toLowerCase()
      if (currentCanonical !== nameCanonical) {
        // User is claiming a new username, old one will be auto-revoked
      }
    }

    // Claim the username
    await claimUsername(c.env.DB, nameDisplay, nameCanonical, pubkey, relays)

    // Sync to Fastly KV for edge routing (async, don't block response)
    c.executionCtx.waitUntil(
      syncUsernameToFastly(c.env, nameCanonical, {
        pubkey,
        relays: relays || [],
        status: 'active'
      })
    )

    // Return success response (use display name for URLs)
    return c.json({
      ok: true,
      name: nameDisplay,
      pubkey,
      profile_url: `https://${nameCanonical}.divine.video/`,
      nip05: {
        main_domain: `${nameCanonical}@divine.video`,
        underscore_subdomain: `_@${nameCanonical}.divine.video`,
        host_style: `@${nameCanonical}.divine.video`
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
