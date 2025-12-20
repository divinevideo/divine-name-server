// ABOUTME: Admin endpoints for username management
// ABOUTME: Protected by Cloudflare Access, handles reserve/revoke/burn/assign

import { Hono } from 'hono'
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName, searchUsernames, getReservedWords } from '../db/queries'
import { validateUsername, UsernameValidationError, validateAndNormalizePubkey, PubkeyValidationError } from '../utils/validation'

type Bindings = {
  DB: D1Database
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

admin.post('/username/reserve', async (c) => {
  try {
    const body = await c.req.json<{ name: string; reason?: string }>()
    const { name, reason = 'Reserved by admin' } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    try {
      validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    await reserveUsername(c.env.DB, name, reason)

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
        validateUsername(name)
        await reserveUsername(c.env.DB, name, reason)
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

    try {
      validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    const existing = await getUsernameByName(c.env.DB, name)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    await revokeUsername(c.env.DB, name, burn)

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
    const body = await c.req.json<{ name: string; pubkey: string }>()
    const { name, pubkey } = body

    if (!name || !pubkey) {
      return c.json({ ok: false, error: 'Name and pubkey are required' }, 400)
    }

    try {
      validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
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

    await assignUsername(c.env.DB, name, normalizedPubkey)

    return c.json({ ok: true, name, pubkey: normalizedPubkey, status: 'active' })
  } catch (error) {
    console.error('Assign error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default admin
