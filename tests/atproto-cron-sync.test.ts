import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Username } from '../src/db/queries'

const { getUsernamesUpdatedSince, expireStaleReservations, syncBatch } = vi.hoisted(() => ({
  getUsernamesUpdatedSince: vi.fn<() => Promise<Username[]>>(),
  expireStaleReservations: vi.fn<() => Promise<number>>(),
  syncBatch: vi.fn(),
}))

vi.mock('../src/db/queries', async () => {
  const actual = await vi.importActual<typeof import('../src/db/queries')>('../src/db/queries')
  return {
    ...actual,
    getUsernamesUpdatedSince,
    expireStaleReservations,
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
    syncBatch.mockResolvedValue({ synced: 1, deleted: 0, failed: 0, errors: [] })
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
})
