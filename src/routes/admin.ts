// ABOUTME: Admin endpoints for username management
// ABOUTME: Protected by Cloudflare Access, handles reserve/revoke/burn/assign

import { Hono } from 'hono'
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName, searchUsernames } from '../db/queries'
import { validateUsername, UsernameValidationError } from '../utils/validation'

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
    const page = parseInt(c.req.query('page') || '1')
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100)

    if (!query) {
      return c.json({ ok: false, error: 'Query parameter "q" is required' }, 400)
    }

    const result = await searchUsernames(c.env.DB, { query, status, page, limit })

    return c.json({
      ok: true,
      ...result
    })
  } catch (error) {
    console.error('Search error:', error)
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

    if (pubkey.length !== 64 || !/^[0-9a-f]+$/.test(pubkey)) {
      return c.json({ ok: false, error: 'Invalid pubkey format' }, 400)
    }

    await assignUsername(c.env.DB, name, pubkey)

    return c.json({ ok: true, name, pubkey, status: 'active' })
  } catch (error) {
    console.error('Assign error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default admin
