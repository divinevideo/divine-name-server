// ABOUTME: Reconciles recoverable username releases for the trusted deletion coordinator.
// ABOUTME: Keeps status, rollback, and permanent burns behind one least-privilege credential.

import { Hono } from 'hono'
import { type UsernameReleaseAttempt, finalizeReleaseAttempt, getReleaseAttemptById, rollbackReleaseAttempt } from '../db/queries'
import { requireServiceToken } from '../middleware/service-auth'
import { reconcileUsernameFastly } from '../utils/username-fastly-reconcile'

type Bindings = {
  DB: D1Database
  DELETION_COORDINATOR_TOKEN?: string
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
}

const internalDeletion = new Hono<{ Bindings: Bindings }>()
internalDeletion.use('/username/release/*', requireServiceToken('DELETION_COORDINATOR_TOKEN', 'Deletion coordinator'))

function parseAttemptId(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 16 && value.length <= 128 ? value : null
}

function attemptResponse(attempt: UsernameReleaseAttempt) {
  return {
    ok: true,
    attempt_id: attempt.attempt_id,
    state: attempt.state,
    username: attempt.username_canonical,
    pubkey: attempt.pubkey,
    expires_at: attempt.expires_at,
  }
}

internalDeletion.get('/username/release/attempt/:attemptId', async (c) => {
  const attemptId = parseAttemptId(c.req.param('attemptId'))
  if (!attemptId) return c.json({ ok: false, error: 'A valid attempt_id is required' }, 400)
  try {
    const attempt = await getReleaseAttemptById(c.env.DB, attemptId)
    if (!attempt) return c.json({ ok: false, error: 'Release attempt not found', code: 'attempt_not_found' }, 404)
    return c.json(attemptResponse(attempt))
  } catch (error) {
    console.error('Read release attempt error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

internalDeletion.post('/username/release/rollback', async (c) => {
  try {
    const body = await c.req.json<{ attempt_id?: unknown }>()
    const attemptId = parseAttemptId(body.attempt_id)
    if (!attemptId) return c.json({ ok: false, error: 'A valid attempt_id is required' }, 400)
    const attempt = await getReleaseAttemptById(c.env.DB, attemptId)
    if (!attempt) return c.json({ ok: false, error: 'Release attempt not found', code: 'attempt_not_found' }, 404)
    const result = await rollbackReleaseAttempt(
      c.env.DB,
      attempt.pubkey,
      attempt.username_canonical,
      attempt.attempt_id,
    )
    if (result.outcome === 'conflict') {
      const code = result.attempt?.state === 'finalized' ? 'attempt_finalized' : 'attempt_conflict'
      return c.json({ ok: false, error: 'Release attempt cannot be rolled back', code }, 409)
    }
    if (result.outcome === 'not_found') {
      return c.json({ ok: false, error: 'Release attempt not found', code: 'attempt_not_found' }, 404)
    }
    await reconcileUsernameFastly(c.env, result.attempt.username_canonical)
    return c.json(attemptResponse(result.attempt))
  } catch (error) {
    console.error('Rollback release error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

internalDeletion.post('/username/release/finalize', async (c) => {
  try {
    const body = await c.req.json<{ attempt_id?: unknown }>()
    const attemptId = parseAttemptId(body.attempt_id)
    if (!attemptId) {
      return c.json({ ok: false, error: 'A valid attempt_id is required' }, 400)
    }
    const result = await finalizeReleaseAttempt(c.env.DB, attemptId, 'deletion-coordinator')
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
