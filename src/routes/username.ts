// ABOUTME: Username API endpoints for claiming, checking, and reserving usernames
// ABOUTME: Public endpoints: GET /check/:name, GET /by-pubkey/:pubkey, POST /reserve, GET /confirm
// ABOUTME: Authenticated: POST /claim (NIP-98 auth - works for both custodial and non-custodial users)

import { Hono } from 'hono'
import { verifyNip98Event } from '../middleware/nip98'
import { validateUsername, validateRelays, UsernameValidationError, RelayValidationError } from '../utils/validation'
import {
  isReservedWord,
  getUsernameByName,
  getUsernameByPubkey,
  claimUsername,
  countRecentReservationsByEmail,
  createReservation,
  getReservationByToken,
  confirmReservation,
  findSpentProofs,
  storeSpentProofs
} from '../db/queries'
import { syncUsernameToFastly, deleteUsernameFromFastly } from '../utils/fastly-sync'
import { sendReservationConfirmationEmail } from '../utils/email'
import {
  parseCashuToken,
  validateMintAllowlist,
  sumProofAmounts,
  getProofSecrets,
  hashCashuToken,
  CashuValidationError
} from '../utils/cashu'
import { getRegistrationPrice } from '../utils/pricing'

type Bindings = {
  DB: D1Database
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
  SENDGRID_API_KEY?: string
  ALLOWED_MINTS?: string
  NAME_PRICE_JSON?: string
  INVITE_FAUCET_URL?: string
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
      // Expired pending-confirmation reservations are treated as available
      const now = Math.floor(Date.now() / 1000)
      if (existing.status === 'pending-confirmation' && existing.reservation_expires_at && existing.reservation_expires_at < now) {
        return c.json({
          ok: true,
          available: true,
          name: usernameData.display,
          canonical: usernameData.canonical
        }, 200, { 'Access-Control-Allow-Origin': '*' })
      }

      const reason = existing.status === 'active'
        ? 'Username is already taken'
        : existing.status === 'reserved'
        ? 'Username is reserved'
        : existing.status === 'burned'
        ? 'Username is permanently unavailable'
        : existing.status === 'pending-confirmation'
        ? 'Username is pending email confirmation'
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

// Public endpoint: reserve a username with email confirmation (no Nostr auth required)
// Requires either a Cashu payment token or a valid invite code to prevent bot spam
// Rate limited to 5 reservations per email per hour
username.post('/reserve', async (c) => {
  try {
    const body = await c.req.json() as {
      name?: string
      email?: string
      cashu_token?: string
      invite_code?: string
    }
    const { name, email, cashu_token, invite_code } = body

    if (!name || typeof name !== 'string') {
      return c.json({ ok: false, error: 'name is required' }, 400, { 'Access-Control-Allow-Origin': '*' })
    }
    if (!email || typeof email !== 'string') {
      return c.json({ ok: false, error: 'email is required' }, 400, { 'Access-Control-Allow-Origin': '*' })
    }

    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, error: 'Invalid email address' }, 400, { 'Access-Control-Allow-Origin': '*' })
    }

    // Validate username format
    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400, { 'Access-Control-Allow-Origin': '*' })
      }
      throw error
    }

    const { display: nameDisplay, canonical: nameCanonical } = usernameData

    // Check if reserved word
    const reserved = await isReservedWord(c.env.DB, nameCanonical)
    if (reserved) {
      return c.json({ ok: false, error: 'Username is reserved' }, 403, { 'Access-Control-Allow-Origin': '*' })
    }

    // Check if name is already taken
    const existing = await getUsernameByName(c.env.DB, nameCanonical)
    if (existing) {
      const now = Math.floor(Date.now() / 1000)
      const isExpiredPending = existing.status === 'pending-confirmation'
        && existing.reservation_expires_at !== null
        && existing.reservation_expires_at < now

      if (!isExpiredPending) {
        if (existing.status === 'active') {
          return c.json({ ok: false, error: 'Username is already taken' }, 409, { 'Access-Control-Allow-Origin': '*' })
        }
        if (existing.status === 'reserved') {
          return c.json({ ok: false, error: 'Username is already reserved' }, 409, { 'Access-Control-Allow-Origin': '*' })
        }
        if (existing.status === 'burned') {
          return c.json({ ok: false, error: 'Username is permanently unavailable' }, 403, { 'Access-Control-Allow-Origin': '*' })
        }
        if (existing.status === 'pending-confirmation') {
          return c.json({ ok: false, error: 'Username is pending email confirmation' }, 409, { 'Access-Control-Allow-Origin': '*' })
        }
      }
      // Expired pending-confirmation or revoked: allow re-reservation
    }

    // Rate limit: max 5 reservations per email per hour
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600
    const recentCount = await countRecentReservationsByEmail(c.env.DB, email, oneHourAgo)
    if (recentCount >= 5) {
      return c.json({ ok: false, error: 'Too many reservation attempts. Please try again later.' }, 429, { 'Access-Control-Allow-Origin': '*' })
    }

    // Require payment or invite code
    if (!cashu_token && !invite_code) {
      return c.json({ ok: false, error: 'Payment or invite code required' }, 403, { 'Access-Control-Allow-Origin': '*' })
    }

    if (cashu_token) {
      // Parse and validate Cashu token format
      let parsed
      try {
        parsed = parseCashuToken(cashu_token)
      } catch (err) {
        if (err instanceof CashuValidationError) {
          return c.json({ ok: false, error: err.message }, 400, { 'Access-Control-Allow-Origin': '*' })
        }
        throw err
      }

      // Validate mint is in the allowlist
      const allowedMints = (c.env.ALLOWED_MINTS || '')
        .split(',')
        .map(m => m.trim())
        .filter(Boolean)
      try {
        validateMintAllowlist(parsed.tokens, allowedMints)
      } catch (err) {
        if (err instanceof CashuValidationError) {
          return c.json({ ok: false, error: err.message }, 403, { 'Access-Control-Allow-Origin': '*' })
        }
        throw err
      }

      // Validate total amount meets tiered price based on name length/premium status
      const totalAmount = sumProofAmounts(parsed.tokens)
      const minPrice = getRegistrationPrice(nameCanonical, c.env.NAME_PRICE_JSON)
      if (totalAmount < minPrice) {
        return c.json({
          ok: false,
          error: `Insufficient payment: ${totalAmount} sats provided, ${minPrice} sats required`
        }, 402, { 'Access-Control-Allow-Origin': '*' })
      }

      // Check for replayed proofs
      const secrets = getProofSecrets(parsed.tokens)
      const spentSecrets = await findSpentProofs(c.env.DB, secrets)
      if (spentSecrets.length > 0) {
        return c.json({ ok: false, error: 'Cashu proof has already been used' }, 409, { 'Access-Control-Allow-Origin': '*' })
      }

      // Store proofs as spent before creating the reservation
      const tokenHash = await hashCashuToken(cashu_token)
      const proofData = parsed.tokens.flatMap(t =>
        t.proofs.map(p => ({ secret: p.secret, amount: p.amount }))
      )
      await storeSpentProofs(c.env.DB, proofData, tokenHash, nameCanonical)

    } else if (invite_code) {
      if (!c.env.INVITE_FAUCET_URL) {
        return c.json({ ok: false, error: 'Invite code redemption not configured' }, 500, { 'Access-Control-Allow-Origin': '*' })
      }

      // Redeem invite code via the faucet service
      const faucetRes = await fetch(`${c.env.INVITE_FAUCET_URL}/api/invite/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: invite_code })
      })

      if (!faucetRes.ok) {
        return c.json({ ok: false, error: 'Invalid invite code' }, 403, { 'Access-Control-Allow-Origin': '*' })
      }
    }

    // Generate confirmation token and set expiry (48 hours)
    const token = crypto.randomUUID()
    const expiresAt = Math.floor(Date.now() / 1000) + (48 * 60 * 60)

    // Persist reservation
    await createReservation(c.env.DB, nameDisplay, nameCanonical, email, token, expiresAt)

    // Send confirmation email (if API key configured)
    if (c.env.SENDGRID_API_KEY) {
      const confirmationUrl = `https://names.divine.video/confirm?token=${token}`
      c.executionCtx.waitUntil(
        sendReservationConfirmationEmail(c.env.SENDGRID_API_KEY, email, nameDisplay, confirmationUrl)
          .catch(err => console.error('Failed to send confirmation email:', err))
      )
    } else {
      console.warn('SENDGRID_API_KEY not set - skipping confirmation email')
    }

    return c.json({
      ok: true,
      message: 'Reservation created. Check your email to confirm.',
      name: nameDisplay,
      canonical: nameCanonical
    }, 200, { 'Access-Control-Allow-Origin': '*' })

  } catch (error) {
    console.error('Reserve error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500, { 'Access-Control-Allow-Origin': '*' })
  }
})

// Public endpoint: confirm a username reservation via email token
// Linked from the confirmation email sent by /reserve
username.get('/confirm', async (c) => {
  try {
    const token = c.req.query('token')

    if (!token) {
      return c.json({ ok: false, error: 'token is required' }, 400, { 'Access-Control-Allow-Origin': '*' })
    }

    const reservation = await getReservationByToken(c.env.DB, token)

    if (!reservation) {
      return c.json({ ok: false, error: 'Invalid or expired confirmation token' }, 404, { 'Access-Control-Allow-Origin': '*' })
    }

    if (reservation.confirmed_at !== null) {
      return c.json({ ok: false, error: 'This token has already been used' }, 409, { 'Access-Control-Allow-Origin': '*' })
    }

    const now = Math.floor(Date.now() / 1000)
    if (reservation.expires_at < now) {
      return c.json({ ok: false, error: 'Confirmation token has expired' }, 410, { 'Access-Control-Allow-Origin': '*' })
    }

    // Subscription expires 1 year from confirmation
    const subscriptionExpiresAt = now + (365 * 24 * 60 * 60)

    await confirmReservation(c.env.DB, token, reservation.username_canonical, subscriptionExpiresAt)

    return c.json({
      ok: true,
      message: 'Username reserved successfully.',
      canonical: reservation.username_canonical,
      subscription_expires_at: subscriptionExpiresAt
    }, 200, { 'Access-Control-Allow-Origin': '*' })

  } catch (error) {
    console.error('Confirm error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500, { 'Access-Control-Allow-Origin': '*' })
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
      if (existing.status === 'pending-confirmation') {
        return c.json({ ok: false, error: 'Username is pending email confirmation' }, 409)
      }
      // If revoked and recyclable, allow claim (continue below)
    }

    // Check if pubkey already has an active username
    const currentUsername = await getUsernameByPubkey(c.env.DB, pubkey)
    if (currentUsername) {
      const currentCanonical = currentUsername.username_canonical || currentUsername.name?.toLowerCase()
      if (currentCanonical && currentCanonical !== nameCanonical) {
        // User is claiming a new username, old one will be auto-revoked in D1.
        // Also delete the old entry from Fastly KV so it stops resolving.
        c.executionCtx.waitUntil(
          deleteUsernameFromFastly(c.env, currentCanonical)
        )
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
