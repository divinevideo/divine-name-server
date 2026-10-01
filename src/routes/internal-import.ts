// ABOUTME: Imports names through D1 ownership checks, never through direct KV writes.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireServiceToken } from '../middleware/service-auth'
import { validateUsername, validateAndNormalizePubkey, validateRelays, UsernameValidationError, PubkeyValidationError, RelayValidationError } from '../utils/validation'
import { reconcileUsernameFastly } from '../utils/username-fastly-reconcile'
import type { FastlyEnv } from '../utils/fastly-sync'

const internalImport = new Hono<{ Bindings: FastlyEnv & { DB: D1Database; USERNAME_IMPORT_TOKEN?: string } }>()
internalImport.use('/username/import', requireServiceToken('USERNAME_IMPORT_TOKEN', 'Username import'))
internalImport.use('/username/import', bodyLimit({ maxSize: 16 * 1024 }))
internalImport.post('/username/import', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || typeof body.pubkey !== 'string') {
    return c.json({ ok: false, error: 'name and pubkey are required strings' }, 400)
  }
  try {
    const { display, canonical } = validateUsername(body.name)
    const pubkey = validateAndNormalizePubkey(body.pubkey)
    validateRelays(body.relays)
    const now = Math.floor(Date.now() / 1000)
    // Ignore every unique conflict, including the one-owned-name-per-pubkey
    // index. Imports must never release, reclaim or update an existing row.
    const result = await c.env.DB.prepare(`
      INSERT INTO usernames (name, username_display, username_canonical, pubkey, relays,
        status, claim_source, created_at, updated_at, claimed_at)
      SELECT ?, ?, ?, ?, ?, 'active', 'vine-import', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM reserved_words WHERE word = ?)
      ON CONFLICT DO NOTHING
    `).bind(canonical, display, canonical, pubkey, JSON.stringify(body.relays ?? []), now, now, now, canonical).run()
    if (result.meta.changes === 0) {
      return c.json({ ok: false, error: 'Name is taken, reserved, or pubkey already owns a name' }, 409)
    }
    try {
      await reconcileUsernameFastly(c.env, canonical)
    } catch (error) {
      // The row is committed, so this is a 201. KV catches up through the retry
      // queue or the six-hour cron window; a 500 would only make the caller stop,
      // and its replay would come back as a 409.
      console.error(`Username import KV sync deferred for ${canonical}:`, error instanceof Error ? error.message : 'unknown error')
    }
    return c.json({ ok: true, name: canonical, claim_source: 'vine-import' }, 201)
  } catch (error) {
    if (error instanceof UsernameValidationError || error instanceof PubkeyValidationError || error instanceof RelayValidationError) {
      return c.json({ ok: false, error: error.message }, 400)
    }
    console.error('Username import failed')
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default internalImport
