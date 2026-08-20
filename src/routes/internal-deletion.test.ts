// ABOUTME: Covers service-authenticated terminal username-release finalization.
// ABOUTME: Verifies least-privilege auth and idempotent terminal behavior.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createExecutionContext } from '../db/test-helpers'

const mocks = vi.hoisted(() => ({ finalizeReleaseAttempt: vi.fn(), reconcileUsernameFastly: vi.fn() }))
vi.mock('../db/queries', async () => ({
  ...await vi.importActual<typeof import('../db/queries')>('../db/queries'),
  finalizeReleaseAttempt: mocks.finalizeReleaseAttempt,
}))
vi.mock('../utils/username-fastly-reconcile', () => ({ reconcileUsernameFastly: mocks.reconcileUsernameFastly }))

import internalDeletion from './internal-deletion'
import worker from '../index'

const attempt = {
  attempt_id: 'delete-attempt-00000001', username_canonical: 'alice', pubkey: 'a'.repeat(64), state: 'finalized',
  created_at: 1, updated_at: 2, expires_at: 3, cancelled_at: null, finalized_at: 2, finalized_by: 'deletion-coordinator',
}
const username = { username_canonical: 'alice', name: 'alice', status: 'burned' }

function request(token = 'secret') {
  return new Request('http://localhost/api/internal/username/release/finalize', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ attempt_id: attempt.attempt_id }),
  })
}

describe('internal deletion finalization', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.reconcileUsernameFastly.mockResolvedValue(undefined) })

  it('fails closed when the coordinator token is missing', async () => {
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(request(), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(503)
  })

  it('rejects another service credential', async () => {
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(request('atproto-token'), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(401)
  })

  it('finalizes and safely replays the same attempt', async () => {
    mocks.finalizeReleaseAttempt.mockResolvedValue({ outcome: 'replayed', attempt, username })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(request(), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'finalized' })
  })

  it('does not require the unrelated ATProto credential when mounted in the worker', async () => {
    mocks.finalizeReleaseAttempt.mockResolvedValue({ outcome: 'replayed', attempt, username })
    const response = await worker.fetch(request(), {
      DB: {} as D1Database,
      DELETION_COORDINATOR_TOKEN: 'secret',
      ATPROTO_SYNC_TOKEN: 'different-secret',
      ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    }, createExecutionContext())
    expect(response.status).toBe(200)
  })

  it('does not finalize a cancelled or expired-restored attempt', async () => {
    mocks.finalizeReleaseAttempt.mockResolvedValue({ outcome: 'conflict', attempt: { ...attempt, state: 'expired-restored' } })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(request(), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'attempt_cancelled' })
  })

  it('does not finalize a pending attempt after its recovery deadline', async () => {
    mocks.finalizeReleaseAttempt.mockResolvedValue({
      outcome: 'conflict',
      attempt: { ...attempt, state: 'pending', expires_at: Math.floor(Date.now() / 1000) - 1 },
    })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(request(), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'attempt_expired' })
  })
})
