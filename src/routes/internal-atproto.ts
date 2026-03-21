import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'
import { parseRelayHints, syncUsernameToFastly } from '../utils/fastly-sync'

type Bindings = {
  DB: D1Database
  ATPROTO_SYNC_TOKEN?: string
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
}

type AtprotoState = 'pending' | 'ready' | 'failed' | 'disabled' | null

const internalAtproto = new Hono<{ Bindings: Bindings }>()

internalAtproto.use('*', async (c, next) => {
  const configured = c.env.ATPROTO_SYNC_TOKEN
  if (!configured) {
    return c.json({ ok: false, error: 'ATProto sync token is not configured' }, 503)
  }

  const auth = c.req.header('Authorization') || ''
  if (!auth.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  const token = auth.slice('Bearer '.length)
  if (token !== configured) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  await next()
})

internalAtproto.post('/username/set-atproto', async (c) => {
  try {
    const body = await c.req.json<{
      name: string
      atproto_did: string | null
      atproto_state: AtprotoState
    }>()
    const { name, atproto_did, atproto_state } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    if (atproto_did !== null && atproto_did !== undefined) {
      if (typeof atproto_did !== 'string' || !atproto_did.startsWith('did:plc:')) {
        return c.json({ ok: false, error: 'atproto_did must be a did:plc: identifier' }, 400)
      }
    }

    const validStates: AtprotoState[] = ['pending', 'ready', 'failed', 'disabled', null]
    if (!validStates.includes(atproto_state)) {
      return c.json({ ok: false, error: 'atproto_state must be one of: pending, ready, failed, disabled, or null' }, 400)
    }

    const canonical = name.toLowerCase()
    const existing = await getUsernameByName(c.env.DB, canonical)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      'UPDATE usernames SET atproto_did = ?, atproto_state = ?, updated_at = ? WHERE username_canonical = ? OR name = ?'
    ).bind(atproto_did || null, atproto_state || null, now, canonical, name).run()

    if (existing.status === 'active' && existing.pubkey) {
      await syncUsernameToFastly(c.env, canonical, {
        pubkey: existing.pubkey,
        relays: parseRelayHints(existing.relays),
        status: 'active',
        atproto_did: atproto_did || null,
        atproto_state: atproto_state || null,
      })
    }

    return c.json({
      ok: true,
      name: canonical,
      atproto_did: atproto_did || null,
      atproto_state: atproto_state || null,
    })
  } catch (error) {
    console.error('Internal ATProto sync error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default internalAtproto
