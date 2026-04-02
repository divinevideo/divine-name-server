import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import { syncUsernameToFastly } from '../utils/fastly-sync'

vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true }),
  bulkSyncToFastly: vi.fn().mockResolvedValue({ success: 0, failed: 0, errors: [] }),
  parseRelayHints: vi.fn().mockReturnValue(['wss://relay.damus.io']),
}))

type MockUsername = {
  name: string
  username_display: string
  username_canonical: string
  pubkey: string | null
  relays: string | null
  status: string
  atproto_did: string | null
  atproto_state: 'pending' | 'ready' | 'failed' | 'disabled' | null
  updated_at: number
}

function createMockDB(initial: MockUsername[]): D1Database {
  const usernames = [...initial]

  return {
    prepare: (sql: string) => {
      let bound: unknown[] = []
      return {
        bind: (...params: unknown[]) => {
          bound = params
          return {
            first: async () => {
              if (sql.includes('SELECT * FROM usernames WHERE username_canonical = ? OR name = ?')) {
                const canonical = String(bound[0] || '')
                const raw = String(bound[1] || '')
                return usernames.find((u) => u.username_canonical === canonical || u.name === raw) || null
              }
              return null
            },
            run: async () => {
              if (sql.includes('UPDATE usernames SET atproto_did = ?, atproto_state = ?, updated_at = ?')) {
                const did = (bound[0] as string | null) ?? null
                const state = (bound[1] as MockUsername['atproto_state']) ?? null
                const updatedAt = Number(bound[2] || 0)
                const canonical = String(bound[3] || '')
                const raw = String(bound[4] || '')
                const row = usernames.find((u) => u.username_canonical === canonical || u.name === raw)
                if (row) {
                  row.atproto_did = did
                  row.atproto_state = state
                  row.updated_at = updatedAt
                  return { success: true, meta: { changes: 1 } }
                }
                return { success: true, meta: { changes: 0 } }
              }
              return { success: true, meta: { changes: 1 } }
            },
            all: async () => ({ results: [] }),
          }
        },
      }
    },
  } as unknown as D1Database
}

describe('internal atproto sync route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates atproto fields for an active username when bearer token is valid', async () => {
    const db = createMockDB([
      {
        name: 'alice',
        username_display: 'alice',
        username_canonical: 'alice',
        pubkey: 'abc123',
        relays: '["wss://relay.damus.io"]',
        status: 'active',
        atproto_did: null,
        atproto_state: null,
        updated_at: 0,
      },
    ])

    const req = new Request('https://names.divine.video/api/internal/username/set-atproto', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-sync-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'alice',
        atproto_did: 'did:plc:abc',
        atproto_state: 'ready',
      }),
    })

    const response = await worker.fetch(
      req,
      {
        DB: db,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        ATPROTO_SYNC_TOKEN: 'test-sync-token',
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_STORE_ID: 'store-id',
      } as any,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext
    )

    expect(response.status).toBe(200)
    const json = await response.json() as { ok: boolean; name: string; atproto_state: string | null }
    expect(json.ok).toBe(true)
    expect(json.name).toBe('alice')
    expect(json.atproto_state).toBe('ready')
    expect(syncUsernameToFastly).toHaveBeenCalledTimes(1)
  })

  it('rejects missing bearer token', async () => {
    const db = createMockDB([])
    const req = new Request('https://names.divine.video/api/internal/username/set-atproto', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'alice',
        atproto_did: 'did:plc:abc',
        atproto_state: 'ready',
      }),
    })

    const response = await worker.fetch(
      req,
      {
        DB: db,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        ATPROTO_SYNC_TOKEN: 'test-sync-token',
      } as any,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext
    )

    expect(response.status).toBe(401)
  })

  it('returns 404 when the username does not exist', async () => {
    const db = createMockDB([])
    const req = new Request('https://names.divine.video/api/internal/username/set-atproto', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-sync-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'missing-user',
        atproto_did: 'did:plc:abc',
        atproto_state: 'ready',
      }),
    })

    const response = await worker.fetch(
      req,
      {
        DB: db,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        ATPROTO_SYNC_TOKEN: 'test-sync-token',
      } as any,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext
    )

    expect(response.status).toBe(404)
    expect(syncUsernameToFastly).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid DID payload', async () => {
    const db = createMockDB([
      {
        name: 'alice',
        username_display: 'alice',
        username_canonical: 'alice',
        pubkey: 'abc123',
        relays: '["wss://relay.damus.io"]',
        status: 'active',
        atproto_did: null,
        atproto_state: null,
        updated_at: 0,
      },
    ])

    const req = new Request('https://names.divine.video/api/internal/username/set-atproto', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-sync-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'alice',
        atproto_did: 'did:web:example.com',
        atproto_state: 'ready',
      }),
    })

    const response = await worker.fetch(
      req,
      {
        DB: db,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        ATPROTO_SYNC_TOKEN: 'test-sync-token',
      } as any,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext
    )

    expect(response.status).toBe(400)
    expect(syncUsernameToFastly).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid state payload', async () => {
    const db = createMockDB([
      {
        name: 'alice',
        username_display: 'alice',
        username_canonical: 'alice',
        pubkey: 'abc123',
        relays: '["wss://relay.damus.io"]',
        status: 'active',
        atproto_did: null,
        atproto_state: null,
        updated_at: 0,
      },
    ])

    const req = new Request('https://names.divine.video/api/internal/username/set-atproto', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-sync-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'alice',
        atproto_did: 'did:plc:abc',
        atproto_state: 'unknown',
      }),
    })

    const response = await worker.fetch(
      req,
      {
        DB: db,
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
        ATPROTO_SYNC_TOKEN: 'test-sync-token',
      } as any,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext
    )

    expect(response.status).toBe(400)
    expect(syncUsernameToFastly).not.toHaveBeenCalled()
  })
})
