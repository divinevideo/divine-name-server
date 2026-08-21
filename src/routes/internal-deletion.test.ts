// ABOUTME: Covers service-authenticated username-release status, rollback, and finalization.
// ABOUTME: Verifies least-privilege auth and idempotent terminal behavior.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createExecutionContext } from '../db/test-helpers'

const mocks = vi.hoisted(() => ({
  finalizeReleaseAttempt: vi.fn(),
  getReleaseAttemptById: vi.fn(),
  rollbackReleaseAttempt: vi.fn(),
  reconcileUsernameFastly: vi.fn(),
}))
vi.mock('../db/queries', async () => ({
  ...await vi.importActual<typeof import('../db/queries')>('../db/queries'),
  finalizeReleaseAttempt: mocks.finalizeReleaseAttempt,
  getReleaseAttemptById: mocks.getReleaseAttemptById,
  rollbackReleaseAttempt: mocks.rollbackReleaseAttempt,
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

function attemptRequest(token?: string) {
  return new Request(`http://localhost/api/internal/username/release/attempt/${attempt.attempt_id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

function rollbackRequest(token?: string, body: unknown = { attempt_id: attempt.attempt_id }) {
  return new Request('http://localhost/api/internal/username/release/rollback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
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

describe('internal deletion reconciliation', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.reconcileUsernameFastly.mockResolvedValue(undefined) })

  it('returns the account binding and deadline for coordinator verification', async () => {
    mocks.getReleaseAttemptById.mockResolvedValue({ ...attempt, state: 'pending' })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(new Request(
      `http://localhost/api/internal/username/release/attempt/${attempt.attempt_id}`,
      { headers: { Authorization: 'Bearer secret' } },
    ), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      attempt_id: attempt.attempt_id,
      state: 'pending',
      username: 'alice',
      pubkey: 'a'.repeat(64),
      expires_at: 3,
    })
  })

  it('rolls back by attempt id and confirms the restored state', async () => {
    const pending = { ...attempt, state: 'pending' }
    const cancelled = { ...attempt, state: 'cancelled' }
    mocks.getReleaseAttemptById.mockResolvedValue(pending)
    mocks.rollbackReleaseAttempt.mockResolvedValue({ outcome: 'transitioned', attempt: cancelled, username: { ...username, status: 'active' } })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(new Request(
      'http://localhost/api/internal/username/release/rollback',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt_id: attempt.attempt_id }),
      },
    ), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(mocks.rollbackReleaseAttempt).toHaveBeenCalledWith(
      expect.anything(), attempt.pubkey, 'alice', attempt.attempt_id,
    )
    expect(await response.json()).toMatchObject({ state: 'cancelled', pubkey: attempt.pubkey })
  })

  it.each(['cancelled', 'expired-restored'] as const)(
    'returns 200 when rollback replays an already-%s restoration',
    async (state) => {
      const restored = { ...attempt, state }
      mocks.getReleaseAttemptById.mockResolvedValue(restored)
      mocks.rollbackReleaseAttempt.mockResolvedValue({
        outcome: 'replayed',
        attempt: restored,
        username: { ...username, status: 'active' },
      })
      const app = new Hono(); app.route('/api/internal', internalDeletion)

      const response = await app.fetch(
        rollbackRequest('secret'),
        { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' },
        createExecutionContext(),
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ state, pubkey: attempt.pubkey })
    },
  )

  it('returns 404 for an unknown status attempt', async () => {
    mocks.getReleaseAttemptById.mockResolvedValue(null)
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(
      attemptRequest('secret'),
      { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' },
      createExecutionContext(),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'attempt_not_found' })
  })

  it('returns 404 for an unknown rollback attempt', async () => {
    mocks.getReleaseAttemptById.mockResolvedValue(null)
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(
      rollbackRequest('secret'),
      { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' },
      createExecutionContext(),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'attempt_not_found' })
    expect(mocks.rollbackReleaseAttempt).not.toHaveBeenCalled()
  })

  it('does not roll back a finalized attempt', async () => {
    mocks.getReleaseAttemptById.mockResolvedValue(attempt)
    mocks.rollbackReleaseAttempt.mockResolvedValue({ outcome: 'conflict', attempt })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(new Request(
      'http://localhost/api/internal/username/release/rollback',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt_id: attempt.attempt_id }),
      },
    ), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'attempt_finalized' })
  })

  it('rejects unauthenticated status and rollback calls', async () => {
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const env = { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }
    expect((await app.fetch(attemptRequest(), env, createExecutionContext())).status).toBe(401)
    expect((await app.fetch(rollbackRequest(), env, createExecutionContext())).status).toBe(401)
    expect(mocks.getReleaseAttemptById).not.toHaveBeenCalled()
    expect(mocks.rollbackReleaseAttempt).not.toHaveBeenCalled()
  })

  it('rejects another service credential on status and rollback', async () => {
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const env = { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret', ATPROTO_SYNC_TOKEN: 'atproto-token' }
    expect((await app.fetch(attemptRequest('atproto-token'), env, createExecutionContext())).status).toBe(401)
    expect((await app.fetch(rollbackRequest('atproto-token'), env, createExecutionContext())).status).toBe(401)
  })

  it('fails closed on status and rollback when the coordinator token is missing', async () => {
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const env = { DB: {} as D1Database }
    expect((await app.fetch(attemptRequest('secret'), env, createExecutionContext())).status).toBe(503)
    expect((await app.fetch(rollbackRequest('secret'), env, createExecutionContext())).status).toBe(503)
  })

  it('serves the nested status path when mounted in the worker', async () => {
    mocks.getReleaseAttemptById.mockResolvedValue({ ...attempt, state: 'pending' })
    const response = await worker.fetch(attemptRequest('secret'), {
      DB: {} as D1Database,
      DELETION_COORDINATOR_TOKEN: 'secret',
      ATPROTO_SYNC_TOKEN: 'different-secret',
      ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ attempt_id: attempt.attempt_id, state: 'pending' })
  })

  it('ignores caller-supplied ownership fields and binds to the stored attempt', async () => {
    mocks.getReleaseAttemptById.mockResolvedValue({ ...attempt, state: 'pending' })
    mocks.rollbackReleaseAttempt.mockResolvedValue({ outcome: 'transitioned', attempt: { ...attempt, state: 'cancelled' }, username: { ...username, status: 'active' } })
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const response = await app.fetch(rollbackRequest('secret', {
      attempt_id: attempt.attempt_id, pubkey: 'b'.repeat(64), name: 'mallory', username: 'mallory',
    }), { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(mocks.rollbackReleaseAttempt).toHaveBeenCalledWith(
      expect.anything(), attempt.pubkey, 'alice', attempt.attempt_id,
    )
  })

  it('rejects an attempt id outside the opaque length bounds', async () => {
    const app = new Hono(); app.route('/api/internal', internalDeletion)
    const env = { DB: {} as D1Database, DELETION_COORDINATOR_TOKEN: 'secret' }
    const status = await app.fetch(new Request(
      'http://localhost/api/internal/username/release/attempt/tooshort',
      { headers: { Authorization: 'Bearer secret' } },
    ), env, createExecutionContext())
    expect(status.status).toBe(400)
    expect((await app.fetch(rollbackRequest('secret', { attempt_id: 'tooshort' }), env, createExecutionContext())).status).toBe(400)
    expect(mocks.getReleaseAttemptById).not.toHaveBeenCalled()
  })
})
