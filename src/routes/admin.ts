// ABOUTME: Admin endpoints for username management
// ABOUTME: Protected by Cloudflare Access, handles reserve/revoke/burn/assign

import { Hono } from 'hono'
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName, searchUsernames, getReservedWords, addReservedWord, deleteReservedWord, exportUsernamesByStatus } from '../db/queries'
import { validateUsername, UsernameValidationError, validateAndNormalizePubkey, PubkeyValidationError } from '../utils/validation'
import { syncUsernameToFastly, deleteUsernameFromFastly } from '../utils/fastly-sync'

type Bindings = {
  DB: D1Database
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
}

const admin = new Hono<{ Bindings: Bindings }>()

// Note: These routes are protected by Cloudflare Access at the edge
// No additional auth needed in worker code

admin.get('/usernames/search', async (c) => {
  try {
    const query = c.req.query('q')
    const status = c.req.query('status') as 'active' | 'reserved' | 'revoked' | 'burned' | undefined
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
    const validStatuses = ['active', 'reserved', 'revoked', 'burned']
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

    const result = await searchUsernames(c.env.DB, { query, status, page, limit: cappedLimit })

    return c.json({
      ok: true,
      ...result
    })
  } catch (error) {
    console.error('Search error:', error)
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
      const error = existing.status === 'active'
        ? 'That username is already taken'
        : `That username is already ${existing.status}`
      return c.json({ ok: false, error }, 409)
    }

    // Include override reason in the reserved_reason if provided
    const finalReason = overrideReason ? `${reason} [Override: ${overrideReason}]` : reason
    await reserveUsername(c.env.DB, usernameData.display, usernameData.canonical, finalReason)

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
    const results = []
    for (const name of nameList) {
      try {
        const usernameData = validateUsername(name)
        // Check if already exists
        const existing = await getUsernameByName(c.env.DB, usernameData.canonical)
        if (existing) {
          const error = existing.status === 'active'
            ? 'That username is already taken'
            : `That username is already ${existing.status}`
          results.push({ name, status: 'failed', success: false, error })
          continue
        }
        await reserveUsername(c.env.DB, usernameData.display, usernameData.canonical, reason)
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
            status: burn ? 'burned' : 'revoked'
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

    await assignUsername(c.env.DB, usernameData.display, usernameData.canonical, normalizedPubkey)

    // Sync to Fastly KV for edge routing
    c.executionCtx.waitUntil(
      syncUsernameToFastly(c.env, usernameData.canonical, {
        pubkey: normalizedPubkey,
        relays: [],
        status: 'active'
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

        await assignUsername(c.env.DB, usernameData.display, usernameData.canonical, normalizedPubkey)

        // Sync to Fastly (fire and forget)
        c.executionCtx.waitUntil(
          syncUsernameToFastly(c.env, usernameData.canonical, {
            pubkey: normalizedPubkey,
            relays: [],
            status: 'active'
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
    const status = c.req.query('status') as 'active' | 'reserved' | 'revoked' | 'burned' | undefined

    // Validate status parameter
    const validStatuses = ['active', 'reserved', 'revoked', 'burned']
    if (status && !validStatuses.includes(status)) {
      return c.json({ ok: false, error: 'Invalid status parameter' }, 400)
    }

    const usernames = await exportUsernamesByStatus(c.env.DB, status)

    // Build CSV content
    const headers = ['name', 'pubkey', 'status', 'created_at', 'claimed_at', 'revoked_at', 'reserved_reason']
    const csvRows = [headers.join(',')]

    for (const u of usernames) {
      const row = [
        u.name,
        u.pubkey || '',
        u.status,
        u.created_at ? new Date(u.created_at * 1000).toISOString() : '',
        u.claimed_at ? new Date(u.claimed_at * 1000).toISOString() : '',
        u.revoked_at ? new Date(u.revoked_at * 1000).toISOString() : '',
        (u.reserved_reason || '').replace(/"/g, '""')
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

export default admin
