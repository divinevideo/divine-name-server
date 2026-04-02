// ABOUTME: Admin endpoints for username management
// ABOUTME: Protected by Cloudflare Access, handles reserve/revoke/burn/assign

import { Hono } from 'hono'
import { bech32 } from '@scure/base'
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName, searchUsernames, getReservedWords, addReservedWord, deleteReservedWord, exportUsernamesByStatus, getAllActiveUsernames, addTag, removeTag, getTagsForUsername, getTagsForUsernames, getAllTags } from '../db/queries'
import { validateUsername, UsernameValidationError, validateAndNormalizePubkey, PubkeyValidationError } from '../utils/validation'
import { syncUsernameToFastly, deleteUsernameFromFastly, bulkSyncToFastly } from '../utils/fastly-sync'
import { sendAssignmentNotificationEmail } from '../utils/email'

/** Convert a 64-char hex pubkey to npub bech32 format */
function hexToNpub(hex: string): string {
  try {
    const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
    // Convert 8-bit bytes to 5-bit words for bech32
    const words: number[] = []
    let acc = 0
    let bits = 0
    for (const byte of bytes) {
      acc = (acc << 8) | byte
      bits += 8
      while (bits >= 5) {
        bits -= 5
        words.push((acc >> bits) & 31)
      }
    }
    if (bits > 0) {
      words.push((acc << (5 - bits)) & 31)
    }
    return bech32.encode('npub', words)
  } catch {
    return ''
  }
}

type Bindings = {
  DB: D1Database
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
  SENDGRID_API_KEY?: string
}

const admin = new Hono<{ Bindings: Bindings }>()

// Defense-in-depth: verify requests come through Cloudflare Access
// Cloudflare Access protects names.admin.divine.video at the edge,
// but the worker is also reachable via names.divine.video which has
// no Access policy. This middleware blocks that bypass.
admin.use('*', async (c, next) => {
  const url = new URL(c.req.url)

  // Only allow admin API on the admin subdomain (and localhost for dev)
  const isAdminHost = url.hostname === 'names.admin.divine.video'
  const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1'

  if (!isAdminHost && !isLocalDev) {
    return c.json({ ok: false, error: 'Unauthorized' }, 403)
  }

  // In production, require Cloudflare Access JWT header
  if (isAdminHost) {
    const cfJwt = c.req.header('Cf-Access-Jwt-Assertion')
    if (!cfJwt) {
      return c.json({ ok: false, error: 'Unauthorized' }, 403)
    }
  }

  await next()
})

admin.get('/usernames/search', async (c) => {
  try {
    const query = c.req.query('q')
    const status = c.req.query('status') as 'active' | 'reserved' | 'revoked' | 'burned' | 'recovered' | undefined
    const pageStr = c.req.query('page') || '1'
    const limitStr = c.req.query('limit') || '50'

    // Validate query parameter (allow empty string for "show all" searches)
    if (query === undefined || query === null) {
      return c.json({ ok: false, error: 'Query parameter "q" is required' }, 400)
    }

    if (query.length > 100) {
      return c.json({ ok: false, error: 'Query must be 100 characters or less' }, 400)
    }

    // Validate status parameter
    const validStatuses = ['active', 'reserved', 'revoked', 'burned', 'recovered']
    if (status && !validStatuses.includes(status)) {
      return c.json({ ok: false, error: 'Invalid status parameter' }, 400)
    }

    // Validate page parameter
    const page = parseInt(pageStr)
    if (isNaN(page) || page < 1) {
      return c.json({ ok: false, error: 'Page must be a positive integer' }, 400)
    }

    // Validate limit parameter
    const limit = parseInt(limitStr)
    if (isNaN(limit) || limit < 1) {
      return c.json({ ok: false, error: 'Limit must be a positive integer' }, 400)
    }

    // Cap limit at 100
    const cappedLimit = Math.min(limit, 100)

    const tagRaw = c.req.query('tag')
    const tag = tagRaw && tagRaw.length <= 50 ? tagRaw : undefined
    const result = await searchUsernames(c.env.DB, { query, status, tag, page, limit: cappedLimit })

    // Batch-load tags for result set
    const ids = result.results.map((r: any) => r.id).filter(Boolean)
    const tagMap = await getTagsForUsernames(c.env.DB, ids)
    const resultsWithTags = result.results.map((r: any) => ({
      ...r,
      tags: tagMap.get(r.id) || []
    }))

    return c.json({
      ok: true,
      results: resultsWithTags,
      pagination: result.pagination,
    })
  } catch (error) {
    console.error('Search error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.get('/username/:name', async (c) => {
  try {
    const name = c.req.param('name')
    if (!name) {
      return c.json({ ok: false, error: 'Name parameter is required' }, 400)
    }

    const username = await getUsernameByName(c.env.DB, name)
    if (!username) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    const tags = await getTagsForUsername(c.env.DB, username.id)
    return c.json({ ok: true, username: { ...username, tags } })
  } catch (error) {
    console.error('Username lookup error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.get('/reserved-words', async (c) => {
  try {
    const words = await getReservedWords(c.env.DB)
    return c.json({ ok: true, words })
  } catch (error) {
    console.error('Reserved words error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/reserved-words', async (c) => {
  try {
    const body = await c.req.json<{ word: string; category: string; reason?: string }>()
    const { word, category, reason } = body

    if (!word || !category) {
      return c.json({ ok: false, error: 'Word and category are required' }, 400)
    }

    // Validate word format (same as username: lowercase alphanumeric)
    const validPattern = /^[a-z0-9]+$/
    if (!validPattern.test(word.toLowerCase())) {
      return c.json({ ok: false, error: 'Word must be lowercase alphanumeric' }, 400)
    }

    if (word.length > 50) {
      return c.json({ ok: false, error: 'Word must be 50 characters or less' }, 400)
    }

    await addReservedWord(c.env.DB, word, category, reason || null)

    return c.json({ ok: true, word: word.toLowerCase(), category, reason })
  } catch (error) {
    console.error('Add reserved word error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.delete('/reserved-words/:word', async (c) => {
  try {
    const word = c.req.param('word')

    if (!word) {
      return c.json({ ok: false, error: 'Word is required' }, 400)
    }

    await deleteReservedWord(c.env.DB, word)

    return c.json({ ok: true, deleted: word.toLowerCase() })
  } catch (error) {
    console.error('Delete reserved word error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/reserve', async (c) => {
  try {
    const body = await c.req.json<{ name: string; reason?: string; overrideReason?: string }>()
    const { name, reason = 'Reserved by admin', overrideReason } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    // Short names (1-2 chars) require override confirmation
    const isShortName = usernameData.canonical.length < 3
    if (isShortName && !overrideReason) {
      return c.json({
        ok: false,
        error: 'Short names (1-2 characters) require override confirmation',
        requiresOverride: true
      }, 400)
    }

    // Check if already exists
    const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
    if (existing) {
      if (existing.status === 'reserved') {
        return c.json({ ok: true, name, status: 'already reserved' })
      }
      const error = existing.status === 'active'
        ? 'That username is already taken'
        : `That username is already ${existing.status}`
      return c.json({ ok: false, error }, 409)
    }

    // Include override reason in the reserved_reason if provided
    const finalReason = overrideReason ? `${reason} [Override: ${overrideReason}]` : reason
    const createdBy = c.req.header('Cf-Access-Authenticated-User-Email') || null
    await reserveUsername(c.env.DB, usernameData.display, usernameData.canonical, finalReason, 'admin', createdBy)

    if (overrideReason) {
      console.log(`Admin override: reserved short name "${name}". Reason: ${overrideReason}`)
    }

    return c.json({ ok: true, name, status: 'reserved' })
  } catch (error) {
    console.error('Reserve error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/reserve-bulk', async (c) => {
  try {
    const body = await c.req.json<{ names: string | string[]; reason?: string }>()
    const { names, reason = 'Reserved by admin' } = body

    if (!names) {
      return c.json({ ok: false, error: 'Names are required' }, 400)
    }

    // Parse names - accept string (comma/space separated) or array
    let nameList: string[]
    if (typeof names === 'string') {
      // Split by comma or space, filter empty strings, strip @ symbols
      nameList = names
        .split(/[,\s]+/)
        .map(n => n.trim().replace(/^@+/, '')) // Strip leading @ symbols
        .filter(n => n.length > 0)
    } else if (Array.isArray(names)) {
      nameList = names
        .map(n => String(n).trim().replace(/^@+/, '')) // Strip leading @ symbols
        .filter(n => n.length > 0)
    } else {
      return c.json({ ok: false, error: 'Names must be a string or array' }, 400)
    }

    if (nameList.length === 0) {
      return c.json({ ok: false, error: 'No valid names provided' }, 400)
    }

    if (nameList.length > 1000) {
      return c.json({ ok: false, error: 'Maximum 1000 names per request' }, 400)
    }

    // Process each name
    const createdBy = c.req.header('Cf-Access-Authenticated-User-Email') || null
    const results = []
    for (const name of nameList) {
      try {
        const usernameData = validateUsername(name)
        // Check if already exists
        const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
        if (existing) {
          if (existing.status === 'reserved') {
            // Already reserved is not a failure — treat as success so bulk uploads
            // don't flag duplicates as errors (makes it easier to spot real issues)
            results.push({ name, status: 'already reserved', success: true })
          } else {
            const error = existing.status === 'active'
              ? 'That username is already taken'
              : `That username is already ${existing.status}`
            results.push({ name, status: 'failed', success: false, error })
          }
          continue
        }
        await reserveUsername(c.env.DB, usernameData.display, usernameData.canonical, reason, 'bulk-upload', createdBy)
        results.push({ name, status: 'reserved', success: true })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        results.push({ name, status: 'failed', success: false, error: errorMessage })
      }
    }

    const successCount = results.filter(r => r.success).length
    const failureCount = results.filter(r => !r.success).length

    return c.json({
      ok: true,
      total: nameList.length,
      successful: successCount,
      failed: failureCount,
      results
    })
  } catch (error) {
    console.error('Bulk reserve error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/revoke', async (c) => {
  try {
    const body = await c.req.json<{ name: string; burn?: boolean }>()
    const { name, burn = false } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    await revokeUsername(c.env.DB, usernameData.canonical, burn)

    // Sync to Fastly - mark as revoked/burned or delete
    c.executionCtx.waitUntil(
      burn
        ? deleteUsernameFromFastly(c.env, usernameData.canonical)
        : syncUsernameToFastly(c.env, usernameData.canonical, {
            pubkey: existing.pubkey || '',
            relays: [],
            status: burn ? 'burned' : 'revoked',
            atproto_did: null,
            atproto_state: null,
          })
    )

    return c.json({
      ok: true,
      name,
      status: burn ? 'burned' : 'revoked',
      recyclable: !burn
    })
  } catch (error) {
    console.error('Revoke error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/assign', async (c) => {
  try {
    const body = await c.req.json<{ name: string; pubkey: string; overrideReason?: string }>()
    const { name, pubkey, overrideReason } = body

    if (!name || !pubkey) {
      return c.json({ ok: false, error: 'Name and pubkey are required' }, 400)
    }

    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    // Short names (1-2 chars) require override confirmation
    const isShortName = usernameData.canonical.length < 3
    if (isShortName && !overrideReason) {
      return c.json({
        ok: false,
        error: 'Short names (1-2 characters) require override confirmation',
        requiresOverride: true
      }, 400)
    }

    // Validate and normalize pubkey (accepts both hex and npub formats)
    let normalizedPubkey: string
    try {
      normalizedPubkey = validateAndNormalizePubkey(pubkey)
    } catch (error) {
      if (error instanceof PubkeyValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    const createdBy = c.req.header('Cf-Access-Authenticated-User-Email') || null
    await assignUsername(c.env.DB, usernameData.display, usernameData.canonical, normalizedPubkey, 'admin', createdBy)

    // Sync to Fastly KV for edge routing
    c.executionCtx.waitUntil(
      syncUsernameToFastly(c.env, usernameData.canonical, {
        pubkey: normalizedPubkey,
        relays: [],
        status: 'active',
        atproto_did: null,
        atproto_state: null,
      })
    )

    if (overrideReason) {
      console.log(`Admin override: assigned short name "${name}" to ${normalizedPubkey.slice(0, 8)}... Reason: ${overrideReason}`)
    }

    return c.json({ ok: true, name, pubkey: normalizedPubkey, status: 'active' })
  } catch (error) {
    console.error('Assign error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/assign-bulk', async (c) => {
  try {
    const body = await c.req.json<{
      assignments: Array<{ name: string; pubkey: string }>;
      overrideShortNames?: boolean;
      skipExisting?: boolean;
    }>()
    const { assignments, overrideShortNames = false, skipExisting = true } = body

    if (!assignments || !Array.isArray(assignments)) {
      return c.json({ ok: false, error: 'Assignments array is required' }, 400)
    }

    if (assignments.length === 0) {
      return c.json({ ok: false, error: 'No assignments provided' }, 400)
    }

    if (assignments.length > 1000) {
      return c.json({ ok: false, error: 'Maximum 1000 assignments per request' }, 400)
    }

    // Process each assignment
    const createdBy = c.req.header('Cf-Access-Authenticated-User-Email') || null
    const results = []
    for (const assignment of assignments) {
      const { name, pubkey } = assignment

      if (!name || !pubkey) {
        results.push({ name: name || '(missing)', success: false, error: 'Name and pubkey are required' })
        continue
      }

      try {
        const usernameData = validateUsername(name)

        // Short names require override flag
        const isShortName = usernameData.canonical.length < 3
        if (isShortName && !overrideShortNames) {
          results.push({ name, success: false, error: 'Short name (1-2 chars) - set overrideShortNames: true to assign' })
          continue
        }

        // Validate pubkey
        const normalizedPubkey = validateAndNormalizePubkey(pubkey)

        // Check if already exists
        const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
        if (existing) {
          if (existing.pubkey === normalizedPubkey) {
            // Already assigned to this pubkey
            results.push({ name, pubkey: normalizedPubkey, success: true, status: 'already_assigned' })
            continue
          }
          if (skipExisting) {
            results.push({ name, success: false, error: `Already ${existing.status} by another pubkey`, status: existing.status })
            continue
          }
        }

        await assignUsername(c.env.DB, usernameData.display, usernameData.canonical, normalizedPubkey, 'bulk-upload', createdBy)

        // Sync to Fastly (fire and forget)
        c.executionCtx.waitUntil(
          syncUsernameToFastly(c.env, usernameData.canonical, {
            pubkey: normalizedPubkey,
            relays: [],
            status: 'active',
            atproto_did: null,
            atproto_state: null,
          })
        )

        results.push({ name, pubkey: normalizedPubkey, success: true, status: 'assigned' })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        results.push({ name, success: false, error: errorMessage })
      }
    }

    const successCount = results.filter(r => r.success).length
    const failureCount = results.filter(r => !r.success).length

    return c.json({
      ok: true,
      total: assignments.length,
      successful: successCount,
      failed: failureCount,
      results
    })
  } catch (error) {
    console.error('Bulk assign error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.get('/export/csv', async (c) => {
  try {
    const status = c.req.query('status') as 'active' | 'reserved' | 'revoked' | 'burned' | 'recovered' | undefined

    // Validate status parameter
    const validStatuses = ['active', 'reserved', 'revoked', 'burned', 'recovered']
    if (status && !validStatuses.includes(status)) {
      return c.json({ ok: false, error: 'Invalid status parameter' }, 400)
    }

    const usernames = await exportUsernamesByStatus(c.env.DB, status)

    // Batch-load tags for all exported usernames
    const ids = usernames.map((u: any) => u.id).filter(Boolean)
    const tagMap = await getTagsForUsernames(c.env.DB, ids)

    // Build CSV content
    const headers = ['name', 'pubkey', 'npub', 'status', 'claim_source', 'created_by', 'created_at', 'claimed_at', 'revoked_at', 'reserved_reason', 'tags']
    const csvRows = [headers.join(',')]

    for (const u of usernames) {
      const uTags = tagMap.get((u as any).id) || []
      const row = [
        u.name,
        u.pubkey || '',
        u.pubkey ? hexToNpub(u.pubkey) : '',
        status === 'recovered' ? 'recovered' : u.status,
        u.claim_source || 'unknown',
        (u.created_by || '').replace(/"/g, '""'),
        u.created_at ? new Date(u.created_at * 1000).toISOString() : '',
        u.claimed_at ? new Date(u.claimed_at * 1000).toISOString() : '',
        u.revoked_at ? new Date(u.revoked_at * 1000).toISOString() : '',
        (u.reserved_reason || '').replace(/"/g, '""'),
        uTags.join(';'),
      ]
      // Escape fields that might contain commas or quotes
      const escapedRow = row.map(field => {
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          return `"${field}"`
        }
        return field
      })
      csvRows.push(escapedRow.join(','))
    }

    const csv = csvRows.join('\n')
    const filename = status ? `usernames-${status}.csv` : 'usernames-all.csv'

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    })
  } catch (error) {
    console.error('Export error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

// Full sync: push all active D1 users to Fastly KV (additive only, never deletes)
admin.post('/sync/fastly', async (c) => {
  try {
    if (!c.env.FASTLY_API_TOKEN || !c.env.FASTLY_STORE_ID) {
      return c.json({ ok: false, error: 'Fastly credentials not configured' }, 400)
    }

    const activeUsers = await getAllActiveUsernames(c.env.DB)

    if (activeUsers.length === 0) {
      return c.json({ ok: true, message: 'No active users to sync', synced: 0 })
    }

    const toSync = activeUsers
      .filter(u => u.pubkey) // Only sync users that have a pubkey
      .map(u => ({
        username: u.username_canonical || u.name,
        data: {
          pubkey: u.pubkey!,
          relays: u.relays ? (() => { try { return JSON.parse(u.relays!) } catch { return [] } })() : [],
          status: 'active' as const,
          atproto_did: u.atproto_did || null,
          atproto_state: u.atproto_state || null,
        }
      }))

    const results = await bulkSyncToFastly(c.env, toSync)

    return c.json({
      ok: true,
      total_active: activeUsers.length,
      synced: results.success,
      failed: results.failed,
      errors: results.errors.length > 0 ? results.errors.slice(0, 20) : undefined
    })
  } catch (error) {
    console.error('Fastly sync error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/notify-assignment', async (c) => {
  try {
    const body = await c.req.json<{ name: string; email: string }>()
    const { name, email } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    if (!email) {
      return c.json({ ok: false, error: 'Email is required' }, 400)
    }

    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, error: 'Invalid email address' }, 400)
    }

    let usernameData: { display: string; canonical: string }
    try {
      usernameData = validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    // Confirm username exists and is active
    const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }
    if (existing.status !== 'active') {
      return c.json({ ok: false, error: `Username is not active (status: ${existing.status})` }, 409)
    }

    if (!c.env.SENDGRID_API_KEY) {
      return c.json({ ok: false, error: 'Email sending not configured' }, 503)
    }

    await sendAssignmentNotificationEmail(c.env.SENDGRID_API_KEY, email, usernameData.display)

    return c.json({ ok: true, name: usernameData.display, email })
  } catch (error) {
    console.error('Notify assignment error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/set-atproto', async (c) => {
  try {
    const body = await c.req.json<{
      name: string
      atproto_did: string | null
      atproto_state: 'pending' | 'ready' | 'failed' | 'disabled' | null
    }>()
    const { name, atproto_did, atproto_state } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    // Validate DID format if provided
    if (atproto_did !== null && atproto_did !== undefined) {
      if (typeof atproto_did !== 'string' || !atproto_did.startsWith('did:plc:')) {
        return c.json({ ok: false, error: 'atproto_did must be a did:plc: identifier' }, 400)
      }
    }

    // Validate state if provided
    const validStates = ['pending', 'ready', 'failed', 'disabled', null]
    if (!validStates.includes(atproto_state)) {
      return c.json({ ok: false, error: 'atproto_state must be one of: pending, ready, failed, disabled, or null' }, 400)
    }

    const canonical = name.toLowerCase()
    const existing = await getUsernameByName(c.env.DB, canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    // Update ATProto fields in D1
    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      `UPDATE usernames SET atproto_did = ?, atproto_state = ?, updated_at = ? WHERE username_canonical = ? OR name = ?`
    ).bind(atproto_did || null, atproto_state || null, now, canonical, name).run()

    // Sync to Fastly KV
    if (existing.status === 'active' && existing.pubkey) {
      const relays = existing.relays ? (() => { try { return JSON.parse(existing.relays!) } catch { return [] } })() : []
      c.executionCtx.waitUntil(
        syncUsernameToFastly(c.env, canonical, {
          pubkey: existing.pubkey,
          relays,
          status: 'active',
          atproto_did: atproto_did || null,
          atproto_state: atproto_state || null,
        })
      )
    }

    return c.json({
      ok: true,
      name: canonical,
      atproto_did: atproto_did || null,
      atproto_state: atproto_state || null,
    })
  } catch (error) {
    console.error('Set ATProto error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

// --- Tags ---

admin.post('/username/:name/tags', async (c) => {
  const name = c.req.param('name')
  const body = await c.req.json<{ tag?: string }>()
  const { tag } = body

  if (!tag || typeof tag !== 'string') {
    return c.json({ ok: false, error: 'tag is required' }, 400)
  }

  const createdBy = c.req.header('Cf-Access-Authenticated-User-Email') || 'unknown'

  const username = await getUsernameByName(c.env.DB, name)
  if (!username) return c.json({ ok: false, error: 'Username not found' }, 404)

  try {
    await addTag(c.env.DB, username.id, tag, createdBy)
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 400)
  }

  const tags = await getTagsForUsername(c.env.DB, username.id)
  return c.json({ ok: true, tags })
})

admin.delete('/username/:name/tags/:tag', async (c) => {
  const name = c.req.param('name')
  const tag = c.req.param('tag')

  const username = await getUsernameByName(c.env.DB, name)
  if (!username) return c.json({ ok: false, error: 'Username not found' }, 404)

  await removeTag(c.env.DB, username.id, tag)
  const tags = await getTagsForUsername(c.env.DB, username.id)
  return c.json({ ok: true, tags })
})

admin.get('/tags', async (c) => {
  try {
    const tags = await getAllTags(c.env.DB)
    return c.json({ ok: true, tags })
  } catch (error) {
    console.error('Get tags error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default admin
