import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Username } from '../src/db/queries'

const { getUsernamesUpdatedSince, expireStaleReservations, getStaleReleaseAttempts, rollbackReleaseAttempt, getQueuedFastlySyncTasks, enqueueFastlySyncTask, clearFastlySyncTasks, markFastlySyncTaskFailures, syncBatch } = vi.hoisted(() => ({
  getUsernamesUpdatedSince: vi.fn<() => Promise<Username[]>>(),
  expireStaleReservations: vi.fn<() => Promise<number>>(),
  getStaleReleaseAttempts: vi.fn<() => Promise<any[]>>(),
  rollbackReleaseAttempt: vi.fn(),
  getQueuedFastlySyncTasks: vi.fn<() => Promise<any[]>>(),
  enqueueFastlySyncTask: vi.fn<() => Promise<void>>(),
  clearFastlySyncTasks: vi.fn<() => Promise<void>>(),
  markFastlySyncTaskFailures: vi.fn<() => Promise<void>>(),
  syncBatch: vi.fn(),
}))

vi.mock('../src/db/queries', async () => {
  const actual = await vi.importActual<typeof import('../src/db/queries')>('../src/db/queries')
  return {
    ...actual,
    getUsernamesUpdatedSince,
    expireStaleReservations,
    getStaleReleaseAttempts,
    rollbackReleaseAttempt,
    getQueuedFastlySyncTasks,
    enqueueFastlySyncTask,
    clearFastlySyncTasks,
    markFastlySyncTaskFailures,
  }
})

vi.mock('../src/utils/fastly-sync', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/fastly-sync')>('../src/utils/fastly-sync')
  return {
    ...actual,
    syncBatch,
  }
})

import worker from '../src/index'

describe('ATProto cron sync payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    expireStaleReservations.mockResolvedValue(0)
    getStaleReleaseAttempts.mockResolvedValue([])
    getQueuedFastlySyncTasks.mockResolvedValue([])
    syncBatch.mockResolvedValue({ synced: 1, deleted: 0, failed: 0, errors: [], successes: [], failures: [] })
  })

  it('includes atproto_did and atproto_state in the hourly Fastly reconciliation payload', async () => {
    getUsernamesUpdatedSince.mockResolvedValue([
      {
        id: 1,
        name: 'alice',
        username_display: 'alice',
        username_canonical: 'alice',
        pubkey: 'abc123',
        email: null,
        relays: '["wss://relay.damus.io"]',
        status: 'active',
        recyclable: 0,
        created_at: 0,
        updated_at: 0,
        claimed_at: 0,
        revoked_at: null,
        reserved_reason: null,
        admin_notes: null,
        reservation_email: null,
        confirmation_token: null,
        reservation_expires_at: null,
        subscription_expires_at: null,
        claim_source: 'self-service',
        created_by: null,
        atproto_did: 'did:plc:abc123',
        atproto_state: 'ready',
      },
    ])

    await worker.scheduled(
      {} as ScheduledEvent,
      {
        DB: {} as D1Database,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      },
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext
    )

    expect(syncBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      }),
      [
        {
          username: 'alice',
          action: 'sync',
          data: {
            pubkey: 'abc123',
            relays: ['wss://relay.damus.io'],
            status: 'active',
            atproto_did: 'did:plc:abc123',
            atproto_state: 'ready',
          },
        },
      ],
      { concurrency: 10 }
    )
  })

  it('maps revoked usernames to delete action', async () => {
    getUsernamesUpdatedSince.mockResolvedValue([
      {
        id: 2,
        name: 'baduser',
        username_display: 'baduser',
        username_canonical: 'baduser',
        pubkey: 'def456',
        email: null,
        relays: null,
        status: 'revoked',
        recyclable: 1,
        created_at: 0,
        updated_at: 0,
        claimed_at: 0,
        revoked_at: 1700000000,
        reserved_reason: null,
        admin_notes: null,
        reservation_email: null,
        confirmation_token: null,
        reservation_expires_at: null,
        subscription_expires_at: null,
        claim_source: 'self-service',
        created_by: null,
        atproto_did: null,
        atproto_state: null,
      },
    ])

    await worker.scheduled(
      {} as ScheduledEvent,
      {
        DB: {} as D1Database,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      },
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext
    )

    expect(syncBatch).toHaveBeenCalledWith(
      expect.anything(),
      [{ username: 'baduser', action: 'delete', data: undefined }],
      { concurrency: 10 }
    )
  })

  it('maps pending releases to delete and restores expired attempts before reconciliation', async () => {
    const attempt = {
      attempt_id: 'delete-attempt-00000001', username_canonical: 'alice', pubkey: 'a'.repeat(64),
      state: 'pending', created_at: 1, updated_at: 1, expires_at: 2,
      cancelled_at: null, finalized_at: null, finalized_by: null,
    }
    getStaleReleaseAttempts.mockResolvedValue([attempt])
    rollbackReleaseAttempt.mockResolvedValue({ outcome: 'transitioned', attempt: { ...attempt, state: 'expired-restored' }, username: {} })
    getUsernamesUpdatedSince.mockResolvedValue([{
      id: 7, name: 'pending-user', username_display: 'pending-user', username_canonical: 'pending-user',
      pubkey: 'b'.repeat(64), email: null, relays: null, status: 'pending-release', recyclable: 1,
      created_at: 0, updated_at: 0, claimed_at: 0, revoked_at: null, reserved_reason: null,
      admin_notes: null, admin_notes_updated_by: null, admin_notes_updated_at: null,
      reservation_email: null, confirmation_token: null, reservation_expires_at: null,
      subscription_expires_at: null, claim_source: 'self-service', created_by: null,
      atproto_did: null, atproto_state: null,
    }])
    await worker.scheduled(
      {} as ScheduledEvent,
      { DB: {} as D1Database, ASSETS: { fetch: async () => new Response('', { status: 404 }) } },
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext
    )
    expect(rollbackReleaseAttempt).toHaveBeenCalledWith(expect.anything(), attempt.pubkey, 'alice', attempt.attempt_id, 'expired-restored')
    expect(syncBatch).toHaveBeenCalledWith(expect.anything(), [{ username: 'pending-user', action: 'delete' }], { concurrency: 10 })
  })

  it('filters out active users without pubkeys', async () => {
    getUsernamesUpdatedSince.mockResolvedValue([
      {
        id: 3,
        name: 'reserved-name',
        username_display: 'reserved-name',
        username_canonical: 'reserved-name',
        pubkey: null,
        email: null,
        relays: null,
        status: 'active',
        recyclable: 0,
        created_at: 0,
        updated_at: 0,
        claimed_at: null,
        revoked_at: null,
        reserved_reason: 'brand protection',
        admin_notes: null,
        reservation_email: null,
        confirmation_token: null,
        reservation_expires_at: null,
        subscription_expires_at: null,
        claim_source: 'admin',
        created_by: null,
        atproto_did: null,
        atproto_state: null,
      },
    ])

    await worker.scheduled(
      {} as ScheduledEvent,
      {
        DB: {} as D1Database,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      },
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext
    )

    expect(syncBatch).toHaveBeenCalledWith(
      expect.anything(),
      [],
      { concurrency: 10 }
    )
  })

  it('completes without error when no changes exist', async () => {
    getUsernamesUpdatedSince.mockResolvedValue([])

    await worker.scheduled(
      {} as ScheduledEvent,
      {
        DB: {} as D1Database,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      },
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext
    )

    expect(syncBatch).toHaveBeenCalledWith(
      expect.anything(),
      [],
      { concurrency: 10 }
    )
  })

  it('re-enqueues failed work, preserves queued work, and prefers recent payloads', async () => {
    getQueuedFastlySyncTasks.mockResolvedValue([
      {
        username: 'alice',
        action: 'sync',
        data: {
          pubkey: 'stale-pubkey',
          relays: [],
          status: 'active',
          atproto_did: null,
          atproto_state: null,
        },
        queued_at: 100,
        updated_at: 100,
        last_attempt_at: 110,
        attempt_count: 2,
        last_error: 'old error',
        generation: 3,
      },
      {
        username: 'burned-user',
        action: 'delete',
        queued_at: 90,
        updated_at: 90,
        last_attempt_at: 100,
        attempt_count: 1,
        last_error: 'delete error',
        generation: 2,
      },
    ])
    getUsernamesUpdatedSince.mockResolvedValue([
      {
        id: 1,
        name: 'alice',
        username_display: 'alice',
        username_canonical: 'alice',
        pubkey: 'fresh-pubkey',
        email: null,
        relays: '["wss://relay.damus.io"]',
        status: 'active',
        recyclable: 0,
        created_at: 0,
        updated_at: 0,
        claimed_at: 0,
        revoked_at: null,
        reserved_reason: null,
        admin_notes: null,
        reservation_email: null,
        confirmation_token: null,
        reservation_expires_at: null,
        subscription_expires_at: null,
        claim_source: 'self-service',
        created_by: null,
        atproto_did: 'did:plc:fresh',
        atproto_state: 'ready',
      },
    ])
    syncBatch.mockResolvedValue({
      synced: 0,
      deleted: 1,
      failed: 1,
      errors: ['alice: boom'],
      successes: [{ username: 'burned-user', action: 'delete' }],
      failures: [{ username: 'alice', action: 'sync', error: 'boom' }],
    })

    await worker.scheduled(
      {} as ScheduledEvent,
      {
        DB: {} as D1Database,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      },
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext
    )

    expect(syncBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          username: 'alice',
          data: expect.objectContaining({
            pubkey: 'fresh-pubkey',
            atproto_did: 'did:plc:fresh',
          }),
        }),
        expect.objectContaining({
          username: 'burned-user',
          action: 'delete',
        }),
      ]),
      { concurrency: 10 }
    )
    expect(clearFastlySyncTasks).toHaveBeenCalledWith(expect.anything(), [{ username: 'burned-user', generation: 2 }])
    expect(enqueueFastlySyncTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        username: 'alice',
        data: expect.objectContaining({ pubkey: 'fresh-pubkey' }),
      })
    )
    expect(markFastlySyncTaskFailures).toHaveBeenCalledWith(
      expect.anything(),
      [{ username: 'alice', error: 'boom' }]
    )
  })
})
