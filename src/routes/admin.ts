// ABOUTME: Admin endpoints for username management
// ABOUTME: Protected by Cloudflare Access or Keycast OAuth session

import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { bech32 } from '@scure/base'
import { getSession } from '../auth/keycast-oauth'
import { reserveUsername, revokeUsername, restoreUsername, assignUsername, getUsernameByName, searchUsernames, getReservedWords, addReservedWord, deleteReservedWord, exportUsernamesByStatus, getActiveUsernamesPaginated, countActiveUsernames, addTag, removeTag, getTagDetailsForUsername, getTagsForUsername, getTagsForUsernames, getAllTags, getUsernameStats, updateAdminNotes, enqueueFastlySyncTask, clearFastlySyncTasks, markFastlySyncTaskFailures, type SearchSort } from '../db/queries'
import { validateUsername, UsernameValidationError, validateAndNormalizePubkey, PubkeyValidationError } from '../utils/validation'
import { syncUsernameToFastly, deleteUsernameFromFastly, syncBatch, parseRelayHints, readUsernameFromFastly, syncAndVerifyUsername, usernameKVDataMatches } from '../utils/fastly-sync'
import { sendAssignmentNotificationEmail } from '../utils/email'
import authRoutes from './auth'

const MAX_ADMIN_NOTES_LENGTH = 5000
const VALID_ADMIN_STATUSES = ['active', 'reserved', 'revoked', 'burned', 'pending-confirmation', 'recovered'] as const
type AdminStatusFilter = (typeof VALID_ADMIN_STATUSES)[number]

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
  SESSION_KV?: KVNamespace
  ADMIN_PUBKEYS?: string
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
  SENDGRID_API_KEY?: string
  KEYCAST_URL?: string
  KEYCAST_CLIENT_ID?: string
  BYPASS_LOCAL_AUTH?: string
}

/** Check if a pubkey is in the comma-separated ADMIN_PUBKEYS allowlist. */
function isAdminPubkey(pubkey: string | null, adminPubkeys: string | undefined): boolean {
  if (!pubkey || !adminPubkeys) return false
  return adminPubkeys.split(',').map(p => p.trim().toLowerCase()).includes(pubkey.toLowerCase())
}

const admin = new Hono<{ Bindings: Bindings }>()

// Auth routes mounted first -- they handle their own hostname guard
// and must be accessible without an existing session (chicken-and-egg).
admin.route('/auth', authRoutes)

// Defense-in-depth: verify requests are authenticated.
// Accepts CF Access JWT (edge-injected) or Keycast OAuth session cookie.
// The worker is reachable via names.divine.video (no Access policy),
// so the hostname guard blocks that bypass regardless of auth method.
admin.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  // Only allow admin API on the admin subdomain (and localhost for dev).
  // admin.localhost resolves to 127.0.0.1 via RFC 6761 and mirrors prod routing locally.
  const isAdminHost = url.hostname === 'names.admin.divine.video' || url.hostname === 'admin.localhost'
  const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'admin.localhost'

  if (!isAdminHost && !isLocalDev) {
    return c.json({ ok: false, error: 'Unauthorized' }, 403)
  }

  // Auth routes handle their own security (hostname guard only).
  // Skip the auth check so unauthenticated users can start the OAuth flow.
  if (c.req.path.startsWith('/api/admin/auth/')) {
    return next()
  }

  // Dev bypass, opt-in via BYPASS_LOCAL_AUTH=true in .dev.vars.
  // Default is off so wrangler dev can exercise the real CF Access / Keycast paths
  // against a locally-running Keycast stack.
  if (isLocalDev && c.env.BYPASS_LOCAL_AUTH === 'true') {
    c.set('adminEmail' as never, 'dev@local' as never)
    return next()
  }

  // Path 1: CF Access JWT (existing, edge-injected)
  const cfJwt = c.req.header('Cf-Access-Jwt-Assertion')
  if (cfJwt) {
    const email = c.req.header('Cf-Access-Authenticated-User-Email') || 'unknown'
    c.set('adminEmail' as never, email as never)
    return next()
  }

  // Path 2: Keycast session cookie
  const sessionId = getCookie(c, '__session')
  if (sessionId && c.env.SESSION_KV) {
    const session = await getSession(c.env.SESSION_KV, sessionId)
    if (session) {
      // Authorization: check pubkey against admin allowlist
      // Pattern from divine-invite-darshan (Daniel's admin_pubkeys config)
      if (!isAdminPubkey(session.pubkey, c.env.ADMIN_PUBKEYS)) {
        return c.json({ ok: false, error: 'Forbidden: not an admin' }, 403)
      }
      c.set('adminEmail' as never, session.email as never)
      return next()
    }
  }

  return c.json({ ok: false, error: 'Unauthorized' }, 401)
})

admin.get('/usernames/search', async (c) => {
  try {
    const query = c.req.query('q')
    const status = c.req.query('status') as AdminStatusFilter | undefined
    const sort = c.req.query('sort') as SearchSort | undefined
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
    if (status && !VALID_ADMIN_STATUSES.includes(status)) {
      return c.json({ ok: false, error: 'Invalid status parameter' }, 400)
    }

    // Validate sort parameter
    const validSorts: SearchSort[] = ['relevance', 'newest', 'oldest', 'updated']
    if (sort && !validSorts.includes(sort)) {
      return c.json({ ok: false, error: 'Invalid sort parameter' }, 400)
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
    const result = await searchUsernames(c.env.DB, { query, status, tag, sort, page, limit: cappedLimit })

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

admin.get('/usernames/stats', async (c) => {
  try {
    const stats = await getUsernameStats(c.env.DB)
    return c.json({ ok: true, ...stats })
  } catch (error) {
    console.error('Username stats error:', error)
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

    const tagDetails = await getTagDetailsForUsername(c.env.DB, username.id)
    const tags = tagDetails.map(td => td.tag)
    return c.json({ ok: true, username: { ...username, tags, tag_details: tagDetails } })
  } catch (error) {
    console.error('Username lookup error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/:name/notes', async (c) => {
  try {
    const name = c.req.param('name')
    if (!name) {
      return c.json({ ok: false, error: 'Name parameter is required' }, 400)
    }

    const body = await c.req.json<{ admin_notes?: string | null }>()
    if (body.admin_notes !== undefined && body.admin_notes !== null && typeof body.admin_notes !== 'string') {
      return c.json({ ok: false, error: 'admin_notes must be a string or null' }, 400)
    }

    const adminNotes = body.admin_notes !== undefined ? body.admin_notes : null
    const trimmed = typeof adminNotes === 'string' && adminNotes.trim() ? adminNotes.trim() : null

    if (trimmed && trimmed.length > MAX_ADMIN_NOTES_LENGTH) {
      return c.json({ ok: false, error: `admin_notes must be ${MAX_ADMIN_NOTES_LENGTH} characters or less` }, 400)
    }

    const updatedBy = (c.get('adminEmail' as never) as string) || null
    const updated = await updateAdminNotes(c.env.DB, name, trimmed, updatedBy)
    if (!updated) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    console.log(`Admin notes updated for "${name}" by ${updatedBy || 'unknown'} (${trimmed?.length || 0} chars)`)

    return c.json({ ok: true, ...updated })
  } catch (error) {
    console.error('Update notes error:', error)
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
    const createdBy = (c.get('adminEmail' as never) as string) || null
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
    const createdBy = (c.get('adminEmail' as never) as string) || null
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

    // Delete from Fastly so revoked/burned usernames stop resolving at the edge.
    c.executionCtx.waitUntil(
      deleteUsernameFromFastly(c.env, usernameData.canonical).then(async (result) => {
        if (!result.success) {
          await enqueueFastlySyncTask(c.env.DB, {
            username: usernameData.canonical,
            action: 'delete',
          })
        }
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

admin.post('/username/restore', async (c) => {
  try {
    const body = await c.req.json<{ name: string; pubkey: string; reason?: string }>()
    const { name, pubkey, reason } = body

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

    let normalizedPubkey: string
    try {
      normalizedPubkey = validateAndNormalizePubkey(pubkey)
    } catch (error) {
      if (error instanceof PubkeyValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    if (existing.status === 'active') {
      return c.json({
        ok: false,
        error: 'Username is currently active; revoke before restoring',
        current_pubkey: existing.pubkey,
      }, 409)
    }

    if (existing.status !== 'revoked' && existing.status !== 'burned') {
      return c.json({
        ok: false,
        error: `Cannot restore from status '${existing.status}'`,
      }, 409)
    }

    const restoredBy = (c.get('adminEmail' as never) as string) || null
    const restoreResult = await restoreUsername(
      c.env.DB,
      usernameData.canonical,
      normalizedPubkey,
      reason || null,
      restoredBy
    )

    if (!restoreResult) {
      return c.json({
        ok: false,
        error: 'Username is no longer restorable; reload and try again',
      }, 409)
    }

    const relays = restoreResult.ownerChanged ? [] : parseRelayHints(existing.relays)
    const fastlyData = {
      pubkey: normalizedPubkey,
      relays,
      status: 'active' as const,
      atproto_did: restoreResult.ownerChanged ? null : existing.atproto_did || null,
      atproto_state: restoreResult.ownerChanged ? null : existing.atproto_state || null,
    }

    c.executionCtx.waitUntil(
      (async () => {
        if (restoreResult.releasedUsernameCanonical) {
          const deleteResult = await deleteUsernameFromFastly(c.env, restoreResult.releasedUsernameCanonical)
          if (!deleteResult.success) {
            await enqueueFastlySyncTask(c.env.DB, {
              username: restoreResult.releasedUsernameCanonical,
              action: 'delete',
            })
          }
        }

        const result = await syncAndVerifyUsername(c.env, usernameData.canonical, fastlyData)
        if (!result.success || !result.verified) {
          await enqueueFastlySyncTask(c.env.DB, {
            username: usernameData.canonical,
            action: 'sync',
            data: fastlyData,
          })
        }
      })()
    )

    console.log(
      `Username "${usernameData.canonical}" restored to ${normalizedPubkey.slice(0, 8)}... by ${restoredBy || 'unknown'}${reason ? ` (reason: ${reason})` : ''}`
    )

    return c.json({ ok: true, username: restoreResult.username })
  } catch (error) {
    console.error('Restore error:', error)
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

    const createdBy = (c.get('adminEmail' as never) as string) || null
    await assignUsername(c.env.DB, usernameData.display, usernameData.canonical, normalizedPubkey, 'admin', createdBy)

    // Sync to Fastly KV with read-back verification
    c.executionCtx.waitUntil(
      syncAndVerifyUsername(c.env, usernameData.canonical, {
        pubkey: normalizedPubkey,
        relays: [],
        status: 'active',
        atproto_did: null,
        atproto_state: null,
      }).then(async (result) => {
        if (!result.success || !result.verified) {
          await enqueueFastlySyncTask(c.env.DB, {
            username: usernameData.canonical,
            action: 'sync',
            data: {
              pubkey: normalizedPubkey,
              relays: [],
              status: 'active',
              atproto_did: null,
              atproto_state: null,
            },
          })
        }
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
    const createdBy = (c.get('adminEmail' as never) as string) || null
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

        // Sync to Fastly — no read-back verification on bulk to avoid doubling API calls
        c.executionCtx.waitUntil(
          syncUsernameToFastly(c.env, usernameData.canonical, {
            pubkey: normalizedPubkey,
            relays: [],
            status: 'active',
            atproto_did: null,
            atproto_state: null,
          }).then(async (result) => {
            if (!result.success) {
              await enqueueFastlySyncTask(c.env.DB, {
                username: usernameData.canonical,
                action: 'sync',
                data: {
                  pubkey: normalizedPubkey,
                  relays: [],
                  status: 'active',
                  atproto_did: null,
                  atproto_state: null,
                },
              })
            }
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
    const status = c.req.query('status') as AdminStatusFilter | undefined

    // Validate status parameter
    if (status && !VALID_ADMIN_STATUSES.includes(status)) {
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
        if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes(';')) {
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

// Paginated sync: push active D1 users to Fastly KV one page at a time
admin.post('/sync/fastly', async (c) => {
  try {
    if (!c.env.FASTLY_API_TOKEN || !c.env.FASTLY_STORE_ID) {
      return c.json({ ok: false, error: 'Fastly credentials not configured' }, 400)
    }

    const body: { limit?: number; cursor?: string | null; dry_run?: boolean } = await c.req.json().catch(() => ({}))
    const limit = Math.min(Math.max(body.limit ?? 500, 1), 1000)
    const parsedCursor = body.cursor ? parseInt(body.cursor, 10) : null
    const dryRun = body.dry_run ?? false

    if (body.cursor && (isNaN(parsedCursor!) || parsedCursor! < 0)) {
      return c.json({ ok: false, error: 'Invalid cursor' }, 400)
    }

    const page = await getActiveUsernamesPaginated(c.env.DB, parsedCursor, limit)

    const syncable = page.filter(u => u.pubkey)
    const nextCursor = page.length === limit ? String(page[page.length - 1].id) : null
    const remaining = nextCursor ? await countActiveUsernames(c.env.DB, Number(nextCursor)) : 0

    if (dryRun) {
      const totalActive = await countActiveUsernames(c.env.DB)
      return c.json({
        ok: true,
        dry_run: true,
        total_active: totalActive,
        page_size: page.length,
        syncable: syncable.length,
        skipped: page.length - syncable.length,
        remaining,
        cursor: nextCursor,
      })
    }

    const items = syncable.map(u => ({
      username: u.username_canonical || u.name,
      action: 'sync' as const,
      data: {
        pubkey: u.pubkey!,
        relays: parseRelayHints(u.relays),
        status: 'active' as const,
        atproto_did: u.atproto_did || null,
        atproto_state: u.atproto_state || null,
      },
    }))

    const results = await syncBatch(c.env, items, { concurrency: 10 })
    await clearFastlySyncTasks(c.env.DB, results.successes.map(result => result.username))
    const itemsByUsername = new Map(items.map((item) => [item.username, item]))
    for (const failure of results.failures) {
      const item = itemsByUsername.get(failure.username)
      if (item) {
        await enqueueFastlySyncTask(c.env.DB, item)
      }
    }
    await markFastlySyncTaskFailures(
      c.env.DB,
      results.failures.map(result => ({ username: result.username, error: result.error }))
    )

    return c.json({
      ok: true,
      synced: results.synced,
      deleted: results.deleted,
      failed: results.failed,
      remaining,
      cursor: nextCursor,
      errors: results.errors.length > 0 ? results.errors.slice(0, 20) : undefined,
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

    // Sync to Fastly KV with verification
    if (existing.status === 'active' && existing.pubkey) {
      const relays = parseRelayHints(existing.relays)
      c.executionCtx.waitUntil(
        syncAndVerifyUsername(c.env, canonical, {
          pubkey: existing.pubkey,
          relays,
          status: 'active',
          atproto_did: atproto_did || null,
          atproto_state: atproto_state || null,
        }).then(async (result) => {
          if (!result.success || !result.verified) {
            await enqueueFastlySyncTask(c.env.DB, {
              username: canonical,
              action: 'sync',
              data: {
                pubkey: existing.pubkey!,
                relays,
                status: 'active',
                atproto_did: atproto_did || null,
                atproto_state: atproto_state || null,
              },
            })
          }
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

// --- NIP-05 / Fastly KV Status ---

admin.get('/username/:name/nip05-status', async (c) => {
  try {
    const name = c.req.param('name')
    if (!name) {
      return c.json({ ok: false, error: 'Name parameter is required' }, 400)
    }

    const canonical = name.toLowerCase()
    const existing = await getUsernameByName(c.env.DB, canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    if (existing.status === 'active' && !existing.pubkey) {
      return c.json({
        ok: true,
        status: 'not_applicable',
        reason: 'No pubkey assigned',
      })
    }

    if (!['active', 'revoked', 'burned'].includes(existing.status)) {
      return c.json({
        ok: true,
        status: 'not_applicable',
        reason: `Username status is ${existing.status}`,
      })
    }

    if (!c.env.FASTLY_API_TOKEN || !c.env.FASTLY_STORE_ID) {
      return c.json({ ok: true, status: 'error', detail: 'Fastly credentials not configured' })
    }

    const fastly = await readUsernameFromFastly(c.env, canonical)
    if (!fastly.success) {
      return c.json({ ok: true, status: 'error', detail: fastly.error })
    }

    if (existing.status === 'revoked' || existing.status === 'burned') {
      if (!fastly.data) {
        return c.json({ ok: true, status: 'missing' })
      }

      return c.json({
        ok: true,
        status: 'mismatch',
        reason: `Username is ${existing.status} and still present in Fastly`,
        db: {
          pubkey: existing.pubkey || '',
          relays: parseRelayHints(existing.relays),
          status: existing.status,
          atproto_did: existing.atproto_did || null,
          atproto_state: existing.atproto_state || null,
        },
        fastly: fastly.data,
      })
    }

    if (!fastly.data) {
      return c.json({ ok: true, status: 'missing' })
    }

    if (!existing.pubkey) {
      return c.json({
        ok: true,
        status: 'not_applicable',
        reason: 'No pubkey assigned',
      })
    }

    const expectedFastly = {
      pubkey: existing.pubkey,
      relays: parseRelayHints(existing.relays),
      status: 'active' as const,
      atproto_did: existing.atproto_did || null,
      atproto_state: existing.atproto_state || null,
    }

    if (usernameKVDataMatches(fastly.data, expectedFastly)) {
      return c.json({ ok: true, status: 'synced', fastly: fastly.data })
    }

    return c.json({
      ok: true,
      status: 'mismatch',
      fastly: fastly.data,
      db: expectedFastly,
    })
  } catch (error) {
    console.error('NIP-05 status error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/:name/sync-to-fastly', async (c) => {
  try {
    const name = c.req.param('name')
    if (!name) {
      return c.json({ ok: false, error: 'Name parameter is required' }, 400)
    }

    if (!c.env.FASTLY_API_TOKEN || !c.env.FASTLY_STORE_ID) {
      return c.json({ ok: false, error: 'Fastly credentials not configured' }, 400)
    }

    const canonical = name.toLowerCase()
    const existing = await getUsernameByName(c.env.DB, canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    if (existing.status === 'burned' || existing.status === 'revoked') {
      const deleteResult = await deleteUsernameFromFastly(c.env, canonical)
      if (!deleteResult.success) {
        await enqueueFastlySyncTask(c.env.DB, {
          username: canonical,
          action: 'delete',
        })
      }
      return c.json({
        ok: true,
        action: 'deleted',
        success: deleteResult.success,
        verified: deleteResult.success,
        error: deleteResult.error,
      })
    }

    if (existing.status !== 'active' || !existing.pubkey) {
      return c.json({
        ok: false,
        error: existing.status !== 'active'
          ? `Cannot sync: username status is ${existing.status}`
          : 'Cannot sync: no pubkey assigned',
      }, 400)
    }

    const relays = parseRelayHints(existing.relays)
    const result = await syncAndVerifyUsername(c.env, canonical, {
      pubkey: existing.pubkey,
      relays,
      status: 'active',
      atproto_did: existing.atproto_did || null,
      atproto_state: existing.atproto_state || null,
    })
    if (!result.success || !result.verified) {
      await enqueueFastlySyncTask(c.env.DB, {
        username: canonical,
        action: 'sync',
        data: {
          pubkey: existing.pubkey,
          relays,
          status: 'active',
          atproto_did: existing.atproto_did || null,
          atproto_state: existing.atproto_state || null,
        },
      })
    }

    return c.json({
      ok: true,
      action: 'synced',
      success: result.success,
      verified: result.verified,
      error: result.error,
    })
  } catch (error) {
    console.error('Single username Fastly sync error:', error)
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

  const createdBy = (c.get('adminEmail' as never) as string) || 'unknown'

  const username = await getUsernameByName(c.env.DB, name)
  if (!username) return c.json({ ok: false, error: 'Username not found' }, 404)

  try {
    await addTag(c.env.DB, username.id, tag, createdBy)
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 400)
  }

  const tagDetails = await getTagDetailsForUsername(c.env.DB, username.id)
  const tags = tagDetails.map(td => td.tag)
  return c.json({ ok: true, tags, tag_details: tagDetails })
})

admin.delete('/username/:name/tags/:tag', async (c) => {
  const name = c.req.param('name')
  const tag = c.req.param('tag')

  const username = await getUsernameByName(c.env.DB, name)
  if (!username) return c.json({ ok: false, error: 'Username not found' }, 404)

  await removeTag(c.env.DB, username.id, tag)
  const tagDetails = await getTagDetailsForUsername(c.env.DB, username.id)
  const tags = tagDetails.map(td => td.tag)
  return c.json({ ok: true, tags, tag_details: tagDetails })
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
