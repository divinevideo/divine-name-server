import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Username } from '../src/db/queries'

const { getAllActiveUsernames, expireStaleReservations, bulkSyncToFastly } = vi.hoisted(() => ({
  getAllActiveUsernames: vi.fn<() => Promise<Username[]>>(),
  expireStaleReservations: vi.fn<() => Promise<number>>(),
  bulkSyncToFastly: vi.fn(),
}))

vi.mock('../src/db/queries', async () => {
  const actual = await vi.importActual<typeof import('../src/db/queries')>('../src/db/queries')
  return {
    ...actual,
    getAllActiveUsernames,
    expireStaleReservations,
  }
})

vi.mock('../src/utils/fastly-sync', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/fastly-sync')>('../src/utils/fastly-sync')
  return {
    ...actual,
    bulkSyncToFastly,
  }
})

import worker from '../src/index'

describe('ATProto cron sync payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    expireStaleReservations.mockResolvedValue(0)
    bulkSyncToFastly.mockResolvedValue({ success: 1, failed: 0, errors: [] })
  })

  it('includes atproto_did and atproto_state in the hourly Fastly reconciliation payload', async () => {
    getAllActiveUsernames.mockResolvedValue([
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

    expect(bulkSyncToFastly).toHaveBeenCalledWith(
      expect.objectContaining({
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      }),
      [
        {
          username: 'alice',
          data: {
            pubkey: 'abc123',
            relays: ['wss://relay.damus.io'],
            status: 'active',
            atproto_did: 'did:plc:abc123',
            atproto_state: 'ready',
          },
        },
      ]
    )
  })
})
