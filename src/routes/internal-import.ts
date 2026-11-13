// ABOUTME: Imports names through D1 ownership checks, never through direct KV writes.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireServiceToken } from '../middleware/service-auth'
import { validateUsername, validateAndNormalizePubkey, validateRelays, UsernameValidationError, PubkeyValidationError, RelayValidationError } from '../utils/validation'
import { reconcileUsernameFastly } from '../utils/username-fastly-reconcile'
import type { FastlyEnv } from '../utils/fastly-sync'
import { resolveUsernameBlock, type BlockEnv } from '../utils/name-block'
import { getUsernameByName } from '../db/queries'

const RESERVED = { ok: false, code: 'reserved', error: 'Name is reserved' } as const
const TAKEN = { ok: false, code: 'taken', error: 'Name is taken, or the pubkey cannot receive an imported name' } as const

const internalImport = new Hono<{ Bindings: FastlyEnv & BlockEnv & { DB: D1Database; USERNAME_IMPORT_TOKEN?: string } }>()
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
    // Blocking a name stops new people taking it; it does not take it off whoever
    // already holds one. Same definition as claims' ownedByClaimant. The active
    // owner's replay is the ordinary replay refusal, answered here so neither the
    // reserved-word check nor the insert's exact-match lookup relabels it.
    const existing = await getUsernameByName(c.env.DB, canonical)
    if (existing?.status === 'active' && existing.pubkey?.toLowerCase() === pubkey) {
      return c.json(TAKEN, 409)
    }
    // Hold imports to the same reserved-word rules as self-service claims. The
    // judgment model is never called here: imports arrive in bulk and would spend
    // the per-minute budget live sign-ups share. An ambiguous name with no cached
    // verdict comes back unavailable and is refused; the importer skips it.
    const block = await resolveUsernameBlock(c.env.DB, canonical, c.env, now, false)
    if (block.kind === 'reserved') {
      return c.json(RESERVED, 409)
    }
    if (block.kind === 'unavailable') {
      return c.json({ ok: false, code: 'unavailable', error: 'Name cannot be confirmed clear without a judgment check' }, 409)
    }
    // Ignore every unique conflict, including the one-owned-name-per-pubkey
    // index. Imports must never release, reclaim or update an existing row.
    // A pubkey whose owner finalized an account deletion is refused as well:
    // finalizing clears the released row's pubkey, so that index no longer sees
    // it, and an import has no consent to rebuild the identity the deletion removed.
    const result = await c.env.DB.prepare(`
      INSERT INTO usernames (name, username_display, username_canonical, pubkey, relays,
        status, claim_source, created_at, updated_at, claimed_at)
      SELECT ?, ?, ?, ?, ?, 'active', 'vine-import', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM reserved_words WHERE word = ?)
        AND NOT EXISTS (
          SELECT 1 FROM username_release_attempts WHERE state = 'finalized' AND LOWER(pubkey) = LOWER(?)
        )
      ON CONFLICT DO NOTHING
    `).bind(canonical, display, canonical, pubkey, JSON.stringify(body.relays ?? []), now, now, now, canonical, pubkey).run()
    if (result.meta.changes === 0) {
      // Classification already blocks a term's own spelling, so the exact-match
      // guard fires for a term added after the check above read the list. That is
      // still a reserved refusal; every other refusal is taken.
      const reserved = await c.env.DB.prepare('SELECT 1 FROM reserved_words WHERE word = ?').bind(canonical).first()
      if (reserved) {
        return c.json(RESERVED, 409)
      }
      return c.json(TAKEN, 409)
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
