import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { getActiveUsernamesPaginated, countActiveUsernames, getUsernameByName, syncBatch, readUsernameFromFastly, syncAndVerifyUsername, deleteUsernameFromFastly } = vi.hoisted(() => ({
  getActiveUsernamesPaginated: vi.fn(),
  countActiveUsernames: vi.fn(),
  getUsernameByName: vi.fn(),
  syncBatch: vi.fn(),
  readUsernameFromFastly: vi.fn(),
  syncAndVerifyUsername: vi.fn(),
  deleteUsernameFromFastly: vi.fn(),
}))

vi.mock('../db/queries', async () => {
  const actual = await vi.importActual<typeof import('../db/queries')>('../db/queries')
  return { ...actual, getActiveUsernamesPaginated, countActiveUsernames, getUsernameByName }
})

vi.mock('../utils/fastly-sync', async () => {
  const actual = await vi.importActual<typeof import('../utils/fastly-sync')>('../utils/fastly-sync')
  return { ...actual, syncBatch, readUsernameFromFastly, syncAndVerifyUsername, deleteUsernameFromFastly }
})

vi.mock('../utils/email', () => ({
  sendAssignmentNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendReservationConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}))

import admin from './admin'

function createTestApp() {
  const app = new Hono<{ Bindings: { DB: D1Database; BYPASS_LOCAL_AUTH?: string; FASTLY_API_TOKEN?: string; FASTLY_STORE_ID?: string } }>()
  app.route('/admin', admin)
  return app
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

const baseEnv = {
  DB: {} as D1Database,
  BYPASS_LOCAL_AUTH: 'true',
  FASTLY_API_TOKEN: 'test-token',
  FASTLY_STORE_ID: 'test-store',
}

const activeUsers = [
  { id: 1, name: 'alice', username_canonical: 'alice', pubkey: 'pk1', relays: '["wss://r.damus.io"]', status: 'active', atproto_did: null, atproto_state: null },
  { id: 2, name: 'bob', username_canonical: 'bob', pubkey: 'pk2', relays: null, status: 'active', atproto_did: 'did:plc:bob', atproto_state: 'ready' },
  { id: 3, name: 'nopubkey', username_canonical: 'nopubkey', pubkey: null, relays: null, status: 'active', atproto_did: null, atproto_state: null },
]

describe('POST /admin/sync/fastly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncBatch.mockResolvedValue({ synced: 2, deleted: 0, failed: 0, errors: [] })
    getActiveUsernamesPaginated.mockResolvedValue(activeUsers)
    countActiveUsernames.mockResolvedValue(100)
  })

  it('returns 400 when Fastly config is missing', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await app.fetch(req, { ...baseEnv, FASTLY_API_TOKEN: undefined, FASTLY_STORE_ID: undefined }, ctx)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toContain('Fastly')
  })

  it('syncs first page with default limit', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await app.fetch(req, baseEnv, ctx)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.synced).toBe(2)
    expect(getActiveUsernamesPaginated).toHaveBeenCalledWith(expect.anything(), null, 500)
    expect(syncBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ username: 'alice', action: 'sync' }),
        expect.objectContaining({ username: 'bob', action: 'sync' }),
      ]),
      { concurrency: 10 }
    )
  })

  it('filters out active users without pubkeys', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    await app.fetch(req, baseEnv, ctx)

    const syncItems = syncBatch.mock.calls[0][1]
    expect(syncItems).toHaveLength(2)
    expect(syncItems.find((i: any) => i.username === 'nopubkey')).toBeUndefined()
  })

  it('passes cursor to paginated query', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: '42', limit: 100 }),
    })
    await app.fetch(req, baseEnv, ctx)

    expect(getActiveUsernamesPaginated).toHaveBeenCalledWith(expect.anything(), 42, 100)
  })

  it('returns next cursor when page is full', async () => {
    getActiveUsernamesPaginated.mockResolvedValue([
      { id: 10, name: 'u1', username_canonical: 'u1', pubkey: 'pk1', relays: null, status: 'active', atproto_did: null, atproto_state: null },
      { id: 11, name: 'u2', username_canonical: 'u2', pubkey: 'pk2', relays: null, status: 'active', atproto_did: null, atproto_state: null },
    ])

    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2 }),
    })
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any
    expect(json.cursor).toBe('11')
  })

  it('returns null cursor on last page', async () => {
    getActiveUsernamesPaginated.mockResolvedValue([
      { id: 99, name: 'last', username_canonical: 'last', pubkey: 'pk99', relays: null, status: 'active', atproto_did: null, atproto_state: null },
    ])

    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 500 }),
    })
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any
    expect(json.cursor).toBeNull()
  })

  it('dry run returns counts without calling syncBatch', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    })
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.dry_run).toBe(true)
    expect(json.syncable).toBe(2)
    expect(json.skipped).toBe(1)
    expect(syncBatch).not.toHaveBeenCalled()
  })

  it('clamps limit to 1000 max', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5000 }),
    })
    await app.fetch(req, baseEnv, ctx)
    expect(getActiveUsernamesPaginated).toHaveBeenCalledWith(expect.anything(), null, 1000)
  })

  it('returns 400 for invalid cursor', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: 'notanumber' }),
    })
    const res = await app.fetch(req, baseEnv, ctx)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toContain('cursor')
  })

  it('includes atproto fields in sync data', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    await app.fetch(req, baseEnv, ctx)

    const syncItems = syncBatch.mock.calls[0][1]
    const bob = syncItems.find((i: any) => i.username === 'bob')
    expect(bob.data.atproto_did).toBe('did:plc:bob')
    expect(bob.data.atproto_state).toBe('ready')
  })
})

describe('GET /admin/username/:name/nip05-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns synced when Fastly matches DB', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: 'pk1', status: 'active', relays: null })
    readUsernameFromFastly.mockResolvedValue({ success: true, data: { pubkey: 'pk1', status: 'active', relays: [] } })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/nip05-status')
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.ok).toBe(true)
    expect(json.status).toBe('synced')
  })

  it('returns mismatch when pubkey differs', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: 'pk1', status: 'active', relays: null })
    readUsernameFromFastly.mockResolvedValue({ success: true, data: { pubkey: 'wrong', status: 'active', relays: [] } })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/nip05-status')
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.status).toBe('mismatch')
    expect(json.fastly.pubkey).toBe('wrong')
    expect(json.db.pubkey).toBe('pk1')
  })

  it('returns missing when key not in Fastly', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: 'pk1', status: 'active', relays: null })
    readUsernameFromFastly.mockResolvedValue({ success: true, data: undefined })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/nip05-status')
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.status).toBe('missing')
  })

  it('returns not_applicable for non-active usernames', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: 'pk1', status: 'revoked', relays: null })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/nip05-status')
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.status).toBe('not_applicable')
    expect(readUsernameFromFastly).not.toHaveBeenCalled()
  })

  it('returns not_applicable for active usernames without pubkey', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: null, status: 'active', relays: null })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/nip05-status')
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.status).toBe('not_applicable')
  })

  it('returns 404 for unknown username', async () => {
    getUsernameByName.mockResolvedValue(null)

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/unknown/nip05-status')
    const res = await app.fetch(req, baseEnv, ctx)

    expect(res.status).toBe(404)
  })
})

describe('POST /admin/username/:name/sync-to-fastly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('syncs active username and returns verified result', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: 'pk1', status: 'active', relays: '["wss://r.damus.io"]', atproto_did: null, atproto_state: null })
    syncAndVerifyUsername.mockResolvedValue({ success: true, verified: true })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/sync-to-fastly', { method: 'POST' })
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.ok).toBe(true)
    expect(json.action).toBe('synced')
    expect(json.verified).toBe(true)
    expect(syncAndVerifyUsername).toHaveBeenCalledWith(
      expect.anything(),
      'alice',
      expect.objectContaining({ pubkey: 'pk1', status: 'active' })
    )
  })

  it('deletes burned username from Fastly', async () => {
    getUsernameByName.mockResolvedValue({ name: 'alice', pubkey: 'pk1', status: 'burned' })
    deleteUsernameFromFastly.mockResolvedValue({ success: true })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/sync-to-fastly', { method: 'POST' })
    const res = await app.fetch(req, baseEnv, ctx)
    const json = await res.json() as any

    expect(json.action).toBe('deleted')
    expect(deleteUsernameFromFastly).toHaveBeenCalledWith(expect.anything(), 'alice')
  })

  it('returns 400 for reserved username without pubkey', async () => {
    getUsernameByName.mockResolvedValue({ name: 'reserved1', pubkey: null, status: 'reserved' })

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/reserved1/sync-to-fastly', { method: 'POST' })
    const res = await app.fetch(req, baseEnv, ctx)

    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown username', async () => {
    getUsernameByName.mockResolvedValue(null)

    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/unknown/sync-to-fastly', { method: 'POST' })
    const res = await app.fetch(req, baseEnv, ctx)

    expect(res.status).toBe(404)
  })

  it('returns 400 when Fastly config is missing', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/username/alice/sync-to-fastly', { method: 'POST' })
    const res = await app.fetch(req, { ...baseEnv, FASTLY_API_TOKEN: undefined, FASTLY_STORE_ID: undefined }, ctx)

    expect(res.status).toBe(400)
  })
})
