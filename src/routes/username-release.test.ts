// ABOUTME: Covers the owner-authenticated recoverable username-release API.
// ABOUTME: Verifies idempotency, privacy, eligibility, and terminal-state errors.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createExecutionContext } from '../db/test-helpers'

const mocks = vi.hoisted(() => ({
  verifyNip98Event: vi.fn(),
  getUsernameByPubkey: vi.fn(),
  getLatestReleaseAttemptByPubkey: vi.fn(),
  getReleaseAttemptById: vi.fn(),
  prepareReleaseAttempt: vi.fn(),
  rollbackReleaseAttempt: vi.fn(),
  reconcileUsernameFastly: vi.fn(),
}))

vi.mock('../middleware/nip98', () => ({ verifyNip98Event: mocks.verifyNip98Event }))
vi.mock('../db/queries', async () => ({
  ...await vi.importActual<typeof import('../db/queries')>('../db/queries'),
  getUsernameByPubkey: mocks.getUsernameByPubkey,
  getLatestReleaseAttemptByPubkey: mocks.getLatestReleaseAttemptByPubkey,
  getReleaseAttemptById: mocks.getReleaseAttemptById,
  prepareReleaseAttempt: mocks.prepareReleaseAttempt,
  rollbackReleaseAttempt: mocks.rollbackReleaseAttempt,
}))
vi.mock('../utils/username-fastly-reconcile', () => ({ reconcileUsernameFastly: mocks.reconcileUsernameFastly }))

import username from './username'

const pubkey = 'a'.repeat(64)
const attemptId = 'delete-attempt-00000001'
const usernameRow = {
  name: 'Alice', username_display: 'Alice', username_canonical: 'alice', pubkey, status: 'pending-release',
}
const pendingAttempt = {
  attempt_id: attemptId, username_canonical: 'alice', pubkey, state: 'pending',
  created_at: 100, updated_at: 100, expires_at: 200, cancelled_at: null, finalized_at: null, finalized_by: null,
}

function app() {
  const instance = new Hono<{ Bindings: { DB: D1Database } }>()
  instance.route('/api/username', username)
  return instance
}

function post(path: string, body: object) {
  return new Request(`http://localhost/api/username${path}`, {
    method: 'POST', headers: { Authorization: 'Nostr test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('recoverable username release routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyNip98Event.mockResolvedValue(pubkey)
    mocks.getLatestReleaseAttemptByPubkey.mockResolvedValue(null)
    mocks.getReleaseAttemptById.mockResolvedValue(null)
    mocks.reconcileUsernameFastly.mockResolvedValue(undefined)
  })

  it('prepares an owned active name and returns the durable attempt', async () => {
    mocks.getUsernameByPubkey.mockResolvedValue({ ...usernameRow, status: 'active' })
    mocks.prepareReleaseAttempt.mockResolvedValue({ outcome: 'transitioned', attempt: pendingAttempt, username: usernameRow })
    const response = await app().fetch(post('/release/prepare', { name: 'Alice', attempt_id: attemptId }), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ attempt_id: attemptId, state: 'pending', name: 'Alice' })
    expect(mocks.reconcileUsernameFastly).toHaveBeenCalledWith(expect.anything(), 'alice')
  })

  it('rejects a different pending attempt without exposing its identifier', async () => {
    mocks.getUsernameByPubkey.mockResolvedValue(null)
    mocks.getLatestReleaseAttemptByPubkey.mockResolvedValue(pendingAttempt)
    const response = await app().fetch(post('/release/prepare', { name: 'alice', attempt_id: 'delete-attempt-00000002' }), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain(attemptId)
  })

  it('rejects a prepare replay when the submitted name does not match the stored attempt', async () => {
    mocks.getUsernameByPubkey.mockResolvedValue(null)
    mocks.getLatestReleaseAttemptByPubkey.mockResolvedValue(pendingAttempt)
    const response = await app().fetch(post('/release/prepare', { name: 'bob', attempt_id: attemptId }), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(403)
    expect(mocks.prepareReleaseAttempt).not.toHaveBeenCalled()
  })

  it('returns caller-scoped attempt state after reinstall', async () => {
    mocks.getLatestReleaseAttemptByPubkey.mockResolvedValue(pendingAttempt)
    const request = new Request('http://localhost/api/username/release/attempt', { headers: { Authorization: 'Nostr test' } })
    const response = await app().fetch(request, { DB: {} as D1Database }, createExecutionContext())
    expect(await response.json()).toMatchObject({ found: true, attempt_id: attemptId, state: 'pending' })
  })

  it('returns cancelled for a rollback replay', async () => {
    mocks.rollbackReleaseAttempt.mockResolvedValue({
      outcome: 'replayed', attempt: { ...pendingAttempt, state: 'cancelled' }, username: { ...usernameRow, status: 'active' },
    })
    const response = await app().fetch(post('/release/rollback', { name: 'alice', attempt_id: attemptId }), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'cancelled' })
  })

  it('never permits rollback after finalization', async () => {
    mocks.rollbackReleaseAttempt.mockResolvedValue({ outcome: 'conflict', attempt: { ...pendingAttempt, state: 'finalized' } })
    const response = await app().fetch(post('/release/rollback', { name: 'alice', attempt_id: attemptId }), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_finalized' })
  })

  it('bounds opaque attempt identifiers', async () => {
    const response = await app().fetch(post('/release/prepare', { name: 'alice', attempt_id: 'short' }), { DB: {} as D1Database }, createExecutionContext())
    expect(response.status).toBe(400)
    expect(mocks.prepareReleaseAttempt).not.toHaveBeenCalled()
  })
})
