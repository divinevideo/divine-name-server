// ABOUTME: Finalizes recoverable username releases for the trusted deletion coordinator.
// ABOUTME: Keeps permanent burns behind a dedicated least-privilege service credential.

import { Hono } from 'hono'
import { finalizeReleaseAttempt } from '../db/queries'
import { requireServiceToken } from '../middleware/service-auth'
import { reconcileUsernameFastly } from '../utils/username-fastly-reconcile'

type Bindings = {
  DB: D1Database
  DELETION_COORDINATOR_TOKEN?: string
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
}

const internalDeletion = new Hono<{ Bindings: Bindings }>()
internalDeletion.use('/username/release/finalize', requireServiceToken('DELETION_COORDINATOR_TOKEN', 'Deletion coordinator'))

internalDeletion.post('/username/release/finalize', async (c) => {
  try {
    const body = await c.req.json<{ attempt_id?: unknown }>()
    if (typeof body.attempt_id !== 'string' || body.attempt_id.length < 16 || body.attempt_id.length > 128) {
      return c.json({ ok: false, error: 'A valid attempt_id is required' }, 400)
    }
    const result = await finalizeReleaseAttempt(c.env.DB, body.attempt_id, 'deletion-coordinator')
    if (result.outcome === 'not_found') return c.json({ ok: false, error: 'Release attempt not found' }, 404)
    if (result.outcome === 'conflict') {
      const code = result.attempt?.state === 'pending' && result.attempt.expires_at <= Math.floor(Date.now() / 1000)
        ? 'attempt_expired'
        : result.attempt?.state === 'cancelled' || result.attempt?.state === 'expired-restored'
          ? 'attempt_cancelled'
          : 'attempt_conflict'
      return c.json({ ok: false, error: 'Release attempt cannot be finalized', code }, 409)
    }
    await reconcileUsernameFastly(c.env, result.attempt.username_canonical)
    return c.json({ ok: true, attempt_id: result.attempt.attempt_id, state: 'finalized' })
  } catch (error) {
    console.error('Finalize release error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default internalDeletion
