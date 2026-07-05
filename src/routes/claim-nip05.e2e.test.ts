// ABOUTME: End-to-end tests for the claim → NIP-05 resolution path
// ABOUTME: Mounts both username and nip05 routes on a single Hono app
// ABOUTME: Exercises the two-step SQL flow (revoke old name, upsert new name)
// ABOUTME: The revoked_at = NULL clause in Step 2 is the fix from PR #35

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import username from './username'
import nip05 from './nip05'

// Mock NIP-98 middleware
vi.mock('../middleware/nip98', () => ({
  verifyNip98Event: vi.fn()
}))

// Mock email utility to avoid real SendGrid calls in tests
vi.mock('../utils/email', () => ({
  sendReservationConfirmationEmail: vi.fn().mockResolvedValue(undefined)
}))

// Mock Fastly sync utilities
vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  syncAndVerifyUsername: vi.fn().mockResolvedValue({ success: true, verified: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true }),
}))

type MockUsername = {
  id: number
  name: string
  username_display: string | null
  username_canonical: string | null
  pubkey: string | null
  relays: string | null
  status: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
  email: string | null
  reservation_email: string | null
  confirmation_token: string | null
  reservation_expires_at: number | null
  subscription_expires_at: number | null
  claim_source: string
  created_by: string | null
  atproto_did: string | null
  atproto_state: 'pending' | 'ready' | 'failed' | 'disabled' | null
}

/**
 * Stateful mock D1 database that faithfully simulates the two-step SQL flow
 * used by claimUsername in db/queries.ts.
 *
 * Step 1: UPDATE ... SET status='revoked', revoked_at=? WHERE pubkey=? AND status='active'
 * Step 2: INSERT INTO usernames ... ON CONFLICT(username_canonical) DO UPDATE SET ... revoked_at = NULL
 *
 * The check for 'revoked_at = NULL' in Step 2 is intentional: if the fix from PR #35
 * is ever reverted, the revoked_at column will not be cleared and the re-claim test
 * will fail, alerting us to the regression.
 */
function createE2EMockDB(initialUsernames: Partial<MockUsername>[] = []) {
  const now = Math.floor(Date.now() / 1000)

  const mockUsernames: MockUsername[] = initialUsernames.map((u, i) => ({
    id: i + 1,
    name: u.username_canonical || '',
    username_display: u.username_display ?? u.username_canonical ?? null,
    username_canonical: u.username_canonical ?? null,
    pubkey: u.pubkey ?? null,
    relays: u.relays ?? null,
    status: u.status ?? 'active',
    recyclable: u.recyclable ?? 1,
    created_at: u.created_at ?? now,
    updated_at: u.updated_at ?? now,
    claimed_at: u.claimed_at ?? null,
    revoked_at: u.revoked_at ?? null,
    reserved_reason: u.reserved_reason ?? null,
    admin_notes: u.admin_notes ?? null,
    email: u.email ?? null,
    reservation_email: u.reservation_email ?? null,
    confirmation_token: u.confirmation_token ?? null,
    reservation_expires_at: u.reservation_expires_at ?? null,
    subscription_expires_at: u.subscription_expires_at ?? null,
    claim_source: u.claim_source ?? 'self-service',
    created_by: u.created_by ?? null,
    atproto_did: u.atproto_did ?? null,
    atproto_state: u.atproto_state ?? null,
  }))

  return {
    prepare: (sql: string) => {
      let boundParams: any[] = []

      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
              // COUNT queries always return 0 for count-based checks
              if (sql.includes('COUNT(*)') && sql.includes('usernames')) {
                return { count: 0 }
              }
              if (sql.includes('COUNT(*)') && sql.includes('reservation_tokens')) {
                return { count: 0 }
              }

              // Reserved words: never reserved by default
              if (sql.includes('reserved_words')) {
                return null
              }

              // Username lookup by canonical name or legacy name column
              if (sql.includes('username_canonical = ?') || sql.includes('name = ?')) {
                const found = mockUsernames.find(
                  u => u.username_canonical === boundParams[0] || u.name === boundParams[1]
                )
                return found ?? null
              }

              // Username lookup by pubkey + status='active'
              if ((sql.includes('pubkey = ?') || sql.includes('LOWER(pubkey) = LOWER(?)')) && sql.includes('status = ?')) {
                const pubkey = boundParams[0]
                const status = boundParams[1]
                return mockUsernames.find(u => u.pubkey?.toLowerCase() === pubkey.toLowerCase() && u.status === status) ?? null
              }

              return null
            },

            all: async () => {
              return { results: [] }
            },

            run: async () => {
              const ts = Math.floor(Date.now() / 1000)

              // -------------------------------------------------------------------
              // Step 1: Revoke active username for pubkey
              // UPDATE usernames SET status='revoked', revoked_at=?, updated_at=?
              //   WHERE pubkey=? AND status='active'
              // Bound: [revoked_at, updated_at, pubkey]
              // -------------------------------------------------------------------
              if (sql.includes("SET status = 'revoked'") && (sql.includes('WHERE pubkey = ?') || sql.includes('WHERE LOWER(pubkey) = LOWER(?)'))) {
                const pubkey = boundParams[2]
                const record = mockUsernames.find(u => u.pubkey?.toLowerCase() === pubkey.toLowerCase() && u.status === 'active')
                if (record) {
                  record.status = 'revoked'
                  record.revoked_at = boundParams[0]
                  record.updated_at = boundParams[1]
                }
                return { success: true, meta: { changes: record ? 1 : 0 } }
              }

              // -------------------------------------------------------------------
              // Admin revoke: SET status=?, recyclable=?, revoked_at=?, updated_at=?
              //   WHERE username_canonical=? OR name=?
              // Bound: [status, recyclable, revoked_at, updated_at, canonical, name]
              // -------------------------------------------------------------------
              if (sql.includes('SET status = ?') && sql.includes('recyclable = ?') && sql.includes('revoked_at = ?')) {
                const status = boundParams[0] as MockUsername['status']
                const recyclable = boundParams[1]
                const revokedAt = boundParams[2]
                const updatedAt = boundParams[3]
                const canonical = boundParams[4]
                const name = boundParams[5]
                const record = mockUsernames.find(
                  u => u.username_canonical === canonical || u.name === name
                )
                if (record) {
                  record.status = status
                  record.recyclable = recyclable
                  record.revoked_at = revokedAt
                  record.updated_at = updatedAt
                }
                return { success: true, meta: { changes: record ? 1 : 0 } }
              }

              // -------------------------------------------------------------------
              // Step 2: INSERT ON CONFLICT upsert
              // INSERT INTO usernames (name, username_display, username_canonical, pubkey, ...)
              //   VALUES (?, ?, ?, ?, ?, 'active', 'self-service', ?, ?, ?)
              //   ON CONFLICT(username_canonical) DO UPDATE SET ... revoked_at = NULL
              // Bound: [canonical(0), display(1), canonical(2), pubkey(3), relays(4), now(5), now(6), now(7)]
              // -------------------------------------------------------------------
              if (sql.includes('INSERT INTO usernames') && sql.includes('ON CONFLICT')) {
                const name = boundParams[0]
                const display = boundParams[1]
                const canonical = boundParams[2]
                const pubkey = boundParams[3]
                const relays = boundParams[4] ?? null
                const claimedAt = boundParams[7] ?? ts

                const existingIdx = mockUsernames.findIndex(u => u.username_canonical === canonical)

                if (existingIdx >= 0) {
                  // ON CONFLICT path: update the existing record
                  const existing = mockUsernames[existingIdx]
                  existing.name = name
                  existing.username_display = display
                  existing.pubkey = pubkey
                  existing.relays = relays
                  existing.status = 'active'
                  existing.claim_source = 'self-service'
                  existing.created_by = null
                  existing.updated_at = ts
                  existing.claimed_at = claimedAt
                  // Only clear revoked_at if the SQL explicitly sets it to NULL.
                  // This is the fix from PR #35. If it is ever reverted, this
                  // conditional will leave revoked_at set and the re-claim test fails.
                  if (sql.includes('revoked_at = NULL')) {
                    existing.revoked_at = null
                  }
                } else {
                  // Fresh insert
                  mockUsernames.push({
                    id: mockUsernames.length + 1,
                    name,
                    username_display: display,
                    username_canonical: canonical,
                    pubkey,
                    relays,
                    status: 'active',
                    recyclable: 1,
                    created_at: ts,
                    updated_at: ts,
                    claimed_at: claimedAt,
                    revoked_at: null,
                    reserved_reason: null,
                    admin_notes: null,
                    email: null,
                    reservation_email: null,
                    confirmation_token: null,
                    reservation_expires_at: null,
                    subscription_expires_at: null,
                    claim_source: 'self-service',
                    created_by: null,
                    atproto_did: null,
                    atproto_state: null,
                  })
                }

                return { success: true, meta: { changes: 1 } }
              }

              return { success: true, meta: { changes: 0 } }
            }
          }
        }
      }
    },

    // Expose the live array so tests can assert on DB state
    _mockUsernames: mockUsernames,
  } as unknown as D1Database & { _mockUsernames: MockUsername[] }
}

function createTestApp() {
  const app = new Hono<{ Bindings: { DB: D1Database } }>()
  app.route('/api/username', username)
  app.route('', nip05)
  return app
}

const mockEnv = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {}
}

describe('Claim → NIP-05 resolution (e2e)', () => {
  beforeEach(async () => {
    const nip98Module = await import('../middleware/nip98')
    vi.mocked(nip98Module.verifyNip98Event).mockResolvedValue('a'.repeat(64))
  })

  // Task 2
  it('claim a name, then NIP-05 resolves to the pubkey', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    const claimRes = await app.fetch(claimReq, { DB: db }, mockEnv)
    expect(claimRes.status).toBe(200)

    const nip05Req = new Request('http://localhost/.well-known/nostr.json?name=alice')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names.alice).toBe(pubkey)
  })

  // Task 3
  it('re-claim same name clears revoked_at and NIP-05 still resolves', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    const claim1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    await app.fetch(claim1, { DB: db }, mockEnv)

    const claim2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    const res2 = await app.fetch(claim2, { DB: db }, mockEnv)
    expect(res2.status).toBe(200)

    const record = db._mockUsernames.find(u => u.username_canonical === 'alice')
    expect(record).toBeDefined()
    expect(record!.status).toBe('active')
    expect(record!.revoked_at).toBeNull()

    const nip05Req = new Request('http://localhost/.well-known/nostr.json?name=alice')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names.alice).toBe(pubkey)
  })

  // Task 4
  it('switch names: old name stops resolving, new name resolves', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    const claim1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    const res1 = await app.fetch(claim1, { DB: db }, mockEnv)
    expect(res1.status).toBe(200)

    const claim2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob' })
    })
    const res2 = await app.fetch(claim2, { DB: db }, mockEnv)
    expect(res2.status).toBe(200)

    const nip05Alice = new Request('http://localhost/.well-known/nostr.json?name=alice')
    const aliceRes = await app.fetch(nip05Alice, { DB: db }, mockEnv)
    expect(aliceRes.status).toBe(200)
    const aliceJson = await aliceRes.json() as any
    expect(aliceJson.names).toEqual({})

    const nip05Bob = new Request('http://localhost/.well-known/nostr.json?name=bob')
    const bobRes = await app.fetch(nip05Bob, { DB: db }, mockEnv)
    expect(bobRes.status).toBe(200)
    const bobJson = await bobRes.json() as any
    expect(bobJson.names.bob).toBe(pubkey)
  })

  // Task 5
  it('claim a revoked name: NIP-05 resolves to new pubkey, revoked_at is null', async () => {
    const app = createTestApp()
    const revokedAt = 1700000500
    const db = createE2EMockDB([{
      name: 'charlie', username_canonical: 'charlie', username_display: 'charlie',
      pubkey: 'b'.repeat(64), status: 'revoked', revoked_at: revokedAt, recyclable: 1,
    }])
    const newPubkey = 'c'.repeat(64)
    vi.mocked((await import('../middleware/nip98')).verifyNip98Event).mockResolvedValue(newPubkey)

    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'charlie' })
    })
    const claimRes = await app.fetch(claimReq, { DB: db }, mockEnv)
    expect(claimRes.status).toBe(200)

    const record = db._mockUsernames.find(u => u.username_canonical === 'charlie')
    expect(record!.status).toBe('active')
    expect(record!.revoked_at).toBeNull()
    expect(record!.pubkey).toBe(newPubkey)

    const nip05Req = new Request('http://localhost/.well-known/nostr.json?name=charlie')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names.charlie).toBe(newPubkey)
  })

  // Task 6
  it('Fastly KV sync called with status:active after claim', async () => {
    const { syncAndVerifyUsername, deleteUsernameFromFastly } = await import('../utils/fastly-sync')
    vi.mocked(syncAndVerifyUsername).mockClear()
    vi.mocked(deleteUsernameFromFastly).mockClear()

    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)
    const waitUntilPromises: Promise<any>[] = []

    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dave' })
    })
    await app.fetch(claimReq, { DB: db }, {
      waitUntil: (p: Promise<any>) => { waitUntilPromises.push(p) },
      passThroughOnException: () => {},
      props: {}
    })

    // Flush waitUntil promises so Fastly sync mock gets called
    await Promise.all(waitUntilPromises)

    expect(syncAndVerifyUsername).toHaveBeenCalledWith(
      expect.objectContaining({}),
      'dave',
      expect.objectContaining({
        pubkey,
        status: 'active',
      })
    )
  })

  // Task 7
  it('subdomain NIP-05 resolves after claim', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'eve' })
    })
    await app.fetch(claimReq, { DB: db }, mockEnv)

    const nip05Req = new Request('http://eve.divine.video/.well-known/nostr.json')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names['_']).toBe(pubkey)
  })
})
