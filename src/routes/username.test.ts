// ABOUTME: Tests for username claiming with case-insensitive matching
// ABOUTME: Ensures canonical usernames prevent collisions and preserve display case

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import username from './username'
import { createExecutionContext } from '../db/test-helpers'

// Mock NIP-98 middleware
vi.mock('../middleware/nip98', () => ({
  verifyNip98Event: vi.fn()
}))

// Mock email utility to avoid real SendGrid calls in tests
vi.mock('../utils/email', () => ({
  sendReservationConfirmationEmail: vi.fn().mockResolvedValue(undefined)
}))

// Mock Fastly sync utilities
vi.mock('../utils/fastly-sync', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/fastly-sync')>(),
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  syncAndVerifyUsername: vi.fn().mockResolvedValue({ success: true, verified: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true }),
}))

// Mock D1 database with support for reservations and spent Cashu proofs
function createMockDB(initialUsernames: any[] = []) {
  const mockUsernames: any[] = [...initialUsernames]
  const mockReservationTokens: any[] = []
  const mockSpentProofs: Set<string> = new Set()

  return {
    prepare: (sql: string) => {
      let boundParams: any[] = []
      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
              if (sql.includes('FROM username_release_attempts')) {
                return null
              }
              // Spent Cashu proof lookup
              if (sql.includes('FROM spent_cashu_proofs WHERE proof_secret = ?')) {
                const secret = boundParams[0]
                return mockSpentProofs.has(secret) ? { proof_secret: secret } : null
              }

              // Token lookup in reservation_tokens
              if (sql.includes('FROM reservation_tokens WHERE token = ?')) {
                const token = boundParams[0]
                return mockReservationTokens.find(t => t.token === token) || null
              }

              // Rate limit count: reservations by email since timestamp
              if (sql.includes('COUNT(*)') && sql.includes('reservation_tokens') && sql.includes('email = ?')) {
                const email = boundParams[0]
                const since = boundParams[1]
                const count = mockReservationTokens.filter(t => t.email === email && t.created_at > since).length
                return { count }
              }

              // Count query for search
              if (sql.includes('COUNT(*)') && sql.includes('usernames')) {
                return { count: 0 }
              }

              // Check for existing username lookup
              if (sql.includes('username_canonical = ?') || sql.includes('name = ?')) {
                const lookupValue = boundParams[0] || boundParams[1]
                const found = mockUsernames.find(u =>
                  u.username_canonical === lookupValue || u.name === lookupValue
                )
                return found || null
              }

              // Check for reserved word
              if (sql.includes('reserved_words')) {
                return null // Not reserved by default
              }

              // Check for pubkey lookup
              if (sql.includes('pubkey = ?') || sql.includes('LOWER(pubkey) = LOWER(?)')) {
                const pubkey = boundParams[0]
                return mockUsernames.find(u => u.pubkey?.toLowerCase() === pubkey.toLowerCase() && u.status === 'active') || null
              }

              return null
            },
            all: async () => {
              return { results: [] }
            },
            run: async () => {
              // Handle reservation_tokens INSERT
              if (sql.includes('INSERT INTO reservation_tokens')) {
                const token = boundParams[0]
                const usernameCanonical = boundParams[1]
                const email = boundParams[2]
                const createdAt = boundParams[3]
                const expiresAt = boundParams[4]
                mockReservationTokens.push({
                  id: mockReservationTokens.length + 1,
                  token,
                  username_canonical: usernameCanonical,
                  email,
                  created_at: createdAt,
                  confirmed_at: null,
                  expires_at: expiresAt
                })
                return { success: true, meta: { changes: 1 } }
              }

              // Handle reservation_tokens UPDATE (confirm)
              if (sql.includes('UPDATE reservation_tokens SET confirmed_at')) {
                const confirmedAt = boundParams[0]
                const token = boundParams[1]
                const tokenRecord = mockReservationTokens.find(t => t.token === token)
                if (tokenRecord) {
                  tokenRecord.confirmed_at = confirmedAt
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Handle username INSERT with pending-confirmation
              if (sql.includes("'pending-confirmation'") || sql.includes('pending-confirmation')) {
                const canonical = boundParams[2]
                const email = boundParams[3]
                const token = boundParams[4]
                const expiresAt = boundParams[5]
                const existing = mockUsernames.findIndex(u => u.username_canonical === canonical)
                if (existing >= 0) {
                  mockUsernames[existing] = {
                    ...mockUsernames[existing],
                    status: 'pending-confirmation',
                    reservation_email: email,
                    confirmation_token: token,
                    reservation_expires_at: expiresAt,
                    updated_at: Math.floor(Date.now() / 1000)
                  }
                } else {
                  mockUsernames.push({
                    id: mockUsernames.length + 1,
                    name: canonical,
                    username_display: boundParams[1],
                    username_canonical: canonical,
                    pubkey: null,
                    relays: null,
                    status: 'pending-confirmation',
                    recyclable: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    updated_at: Math.floor(Date.now() / 1000),
                    claimed_at: null,
                    revoked_at: null,
                    reserved_reason: null,
                    admin_notes: null,
                    email: null,
                    reservation_email: email,
                    confirmation_token: token,
                    reservation_expires_at: expiresAt,
                    subscription_expires_at: null
                  })
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Handle active username revocation by pubkey
              if (sql.includes("SET status = 'revoked'") && (sql.includes('pubkey = ?') || sql.includes('LOWER(pubkey) = LOWER(?)'))) {
                const pubkey = boundParams[2]
                for (const record of mockUsernames) {
                  if (record.pubkey?.toLowerCase() === pubkey.toLowerCase() && record.status === 'active') {
                    record.status = 'revoked'
                    record.revoked_at = boundParams[0]
                    record.updated_at = boundParams[1]
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Handle username UPDATE to reserved (confirmation)
              if (sql.includes("SET status = 'reserved'") && sql.includes('pending-confirmation')) {
                const subscriptionExpiresAt = boundParams[0]
                const canonical = boundParams[2]
                const record = mockUsernames.find(u => u.username_canonical === canonical)
                if (record) {
                  record.status = 'reserved'
                  record.confirmation_token = null
                  record.subscription_expires_at = subscriptionExpiresAt
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Handle revokeUsernameByPubkey (scoped burn: canonical AND pubkey)
              if (
                sql.includes('SET status = ?') &&
                sql.includes('recyclable = ?') &&
                sql.includes('LOWER(pubkey)')
              ) {
                const status = boundParams[0]
                const recyclable = boundParams[1]
                const canonical = boundParams[4]
                const pubkey = boundParams[5]
                for (const record of mockUsernames) {
                  if (
                    record.username_canonical === canonical &&
                    record.pubkey?.toLowerCase() === pubkey.toLowerCase()
                  ) {
                    record.status = status
                    record.recyclable = recyclable
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Handle revokeUsername (burn/revoke by canonical or name)
              if (
                sql.includes('SET status = ?') &&
                sql.includes('recyclable = ?') &&
                sql.includes('username_canonical = ?')
              ) {
                const status = boundParams[0]
                const recyclable = boundParams[1]
                const canonical = boundParams[4]
                const name = boundParams[5]
                for (const record of mockUsernames) {
                  if (
                    record.username_canonical === canonical ||
                    record.name === name
                  ) {
                    record.status = status
                    record.recyclable = recyclable
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Handle INSERT/UPDATE operations for claim
              if (sql.includes('INSERT INTO usernames') || sql.includes('ON CONFLICT')) {
                const display = boundParams[1] // username_display
                const canonical = boundParams[2] // username_canonical
                const pubkey = boundParams[3] // pubkey

                // Check if canonical already exists
                const existing = mockUsernames.findIndex(u => u.username_canonical === canonical)

                if (existing >= 0) {
                  // Update existing
                  mockUsernames[existing] = {
                    ...mockUsernames[existing],
                    name: canonical,
                    username_display: display,
                    username_canonical: canonical,
                    pubkey: pubkey,
                    status: 'active'
                  }
                } else {
                  // Insert new
                  mockUsernames.push({
                    id: mockUsernames.length + 1,
                    name: canonical,
                    username_display: display,
                    username_canonical: canonical,
                    pubkey: pubkey,
                    relays: boundParams[4] || null,
                    status: 'active',
                    recyclable: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    updated_at: Math.floor(Date.now() / 1000),
                    claimed_at: Math.floor(Date.now() / 1000),
                    revoked_at: null,
                    reserved_reason: null,
                    admin_notes: null,
                    email: null,
                    reservation_email: null,
                    confirmation_token: null,
                    reservation_expires_at: null,
                    subscription_expires_at: null
                  })
                }
              }

              return { success: true, meta: { changes: 1 } }
            }
          }
        },
        // D1 allows all() without bind() on a parameterless query, which is how
        // the blocklist is read now that each word carries its own match rules.
        // No rows means nothing is reserved, matching first()'s default above.
        first: async () => sql.includes('FROM blocklist_meta') ? { version: 1 } : null,
        all: async () => ({ results: [] }),
      }
    },
    batch: async (statements: Array<{ run: () => Promise<any> }>) => Promise.all(statements.map(statement => statement.run())),
    // Expose internals for test assertions
    _mockUsernames: mockUsernames,
    _mockReservationTokens: mockReservationTokens
  } as unknown as D1Database & { _mockUsernames: any[]; _mockReservationTokens: any[] }
}

describe('Username Claiming - Case Insensitive', () => {
  let verifyNip98Event: any
  
  beforeEach(async () => {
    const nip98Module = await import('../middleware/nip98')
    verifyNip98Event = nip98Module.verifyNip98Event
    vi.mocked(verifyNip98Event).mockResolvedValue('testpubkey123')
  })

  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database } }>()
    app.route('/api/username', username)
    return app
  }

  it('should accept mixed case username and store both display and canonical', async () => {
    const app = createTestApp()
    const db = createMockDB()
    
    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'CreatorExample' })
    })
    
    const res = await app.fetch(req, { DB: db }, createExecutionContext())

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.name).toBe('CreatorExample') // Display name preserved
    expect(verifyNip98Event).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      'http://localhost/api/username/claim',
      JSON.stringify({ name: 'CreatorExample' }),
      300
    )
  })

  it('should prevent case-insensitive collisions', async () => {
    const app = createTestApp()
    const db = createMockDB()

    // First claim: CreatorExample
    const req1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'CreatorExample' })
    })

    const res1 = await app.fetch(req1, { DB: db }, createExecutionContext())
    expect(res1.status).toBe(200)

    // Second claim: creatorexample (should fail)
    vi.mocked(verifyNip98Event).mockResolvedValue('differentpubkey456')
    const req2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'creatorexample' })
    })

    const res2 = await app.fetch(req2, { DB: db }, createExecutionContext())
    expect(res2.status).toBe(409) // Conflict
    const json2 = await res2.json() as any
    expect(json2.error).toBe('That username is already taken')
  })

  it('lets the same owner re-claim their own name when the pubkey case differs (#4199 H4)', async () => {
    const app = createTestApp()
    // Existing active name owned by a lower-cased pubkey.
    const db = createMockDB([
      { id: 1, name: 'CreatorExample', username_display: 'CreatorExample', username_canonical: 'creatorexample', pubkey: 'abc123', status: 'active', relays: null },
    ])
    // NIP-98 presents the SAME key, upper-cased.
    vi.mocked(verifyNip98Event).mockResolvedValue('ABC123')

    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CreatorExample' })
    })

    const res = await app.fetch(req, { DB: db }, createExecutionContext())
    // Without the pubkey normalization this is a 409 (treated as a different owner).
    expect(res.status).toBe(200)
  })

  it('releases a legacy mixed-case active username when the same pubkey claims a new name', async () => {
    const app = createTestApp()
    const db = createMockDB([
      { id: 1, name: 'oldname', username_display: 'OldName', username_canonical: 'oldname', pubkey: 'ABC123', status: 'active', relays: null },
    ])
    vi.mocked(verifyNip98Event).mockResolvedValue('abc123')

    const { deleteUsernameFromFastly } = await import('../utils/fastly-sync')
    vi.mocked(deleteUsernameFromFastly).mockClear()

    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'newname' })
    })

    const res = await app.fetch(req, { DB: db }, createExecutionContext())

    expect(res.status).toBe(200)
    expect(db._mockUsernames.find(u => u.username_canonical === 'oldname')?.status).toBe('revoked')
    expect(db._mockUsernames.find(u => u.username_canonical === 'newname')?.status).toBe('active')
    expect(deleteUsernameFromFastly).toHaveBeenCalledWith(
      expect.objectContaining({}),
      'oldname'
    )
  })

  it('answers the /claim CORS preflight so browsers can POST cross-origin (#4199 H1)', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/api/username/claim', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://app.divine.video',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type'
      }
    })

    const res = await app.fetch(req, { DB: createMockDB() }, createExecutionContext())

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods') || '').toContain('POST')
    expect((res.headers.get('access-control-allow-headers') || '').toLowerCase()).toContain('authorization')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('exposes exactly one Access-Control-Allow-Origin on GET /check (no duplicate) (#4199)', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/api/username/check/probe', {
      headers: { 'Origin': 'https://app.divine.video' }
    })

    const res = await app.fetch(req, { DB: createMockDB() }, createExecutionContext())

    // Headers.get() joins duplicates with ", " — assert a single "*", not "*, *".
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('should validate username format correctly', async () => {
    const app = createTestApp()
    
    // Test invalid username with underscore
    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'alice_123' })
    })
    
    const res = await app.fetch(req, { DB: createMockDB() }, createExecutionContext())
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toContain('underscores')
  })

  it('should reject username starting with hyphen', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: '-alice' })
    })

    const res = await app.fetch(req, { DB: createMockDB() }, createExecutionContext())
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toContain("can't start or end with a hyphen")
  })

  it('should reject username ending with hyphen', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'alice-' })
    })

    const res = await app.fetch(req, { DB: createMockDB() }, createExecutionContext())
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toContain("can't start or end with a hyphen")
  })

  it('should accept username with hyphens in middle', async () => {
    const app = createTestApp()
    const db = createMockDB()
    
    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'm-r-beast-123' })
    })
    
    const res = await app.fetch(req, { DB: db }, createExecutionContext())
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.name).toBe('m-r-beast-123')
  })

  it('should accept single character username', async () => {
    const app = createTestApp()
    const db = createMockDB()

    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'a' })
    })

    const res = await app.fetch(req, { DB: db }, createExecutionContext())
    expect(res.status).toBe(200)
  })

  it('should reject username longer than 63 characters', async () => {
    const app = createTestApp()

    const longName = 'a'.repeat(64)
    const req = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: longName })
    })

    const res = await app.fetch(req, { DB: createMockDB() }, createExecutionContext())
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toContain('1–63 characters')
  })

  it('should delete old username from Fastly KV when claiming a new one', async () => {
    const app = createTestApp()
    const db = createMockDB()
    const waitUntilCalls: Promise<any>[] = []

    // First claim: "oldname"
    const req1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'oldname' })
    })

    await app.fetch(req1, { DB: db }, createExecutionContext({
      waitUntil: (p: Promise<any>) => { waitUntilCalls.push(p) },
    }))

    // Second claim: "newname" (same pubkey)
    const { deleteUsernameFromFastly } = await import('../utils/fastly-sync')
    vi.mocked(deleteUsernameFromFastly).mockClear()

    const req2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'newname' })
    })

    const res2 = await app.fetch(req2, { DB: db }, createExecutionContext({
      waitUntil: (p: Promise<any>) => { waitUntilCalls.push(p) },
    }))
    expect(res2.status).toBe(200)

    // Verify deleteUsernameFromFastly was called with the old name
    expect(deleteUsernameFromFastly).toHaveBeenCalledWith(
      expect.objectContaining({}),
      'oldname'
    )
  })
})

describe('Public Username Endpoints', () => {
  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database } }>()
    app.route('/api/username', username)
    return app
  }

  describe('GET /check/:name - Availability Check', () => {
    it('should return available for unused username', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/check/newuser', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(true)
      expect(json.canonical).toBe('newuser')
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should return unavailable for invalid username format', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/check/bad_user', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(false)
      expect(json.code).toBe('invalid_format')
      expect(json.reason).toContain('underscores')
    })

    it('should return pubkey for active username', async () => {
      const app = createTestApp()
      const ownerPubkey = 'a'.repeat(64)
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: ownerPubkey, status: 'active', reservation_expires_at: null
      }])

      const req = new Request('http://localhost/api/username/check/alice', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(false)
      expect(json.status).toBe('active')
      expect(json.code).toBe('taken')
      expect(json.pubkey).toBe(ownerPubkey)
      expect(json.reason).toBe('Username is already taken')
    })

    it('does not disclose that an unavailable name has a pending release', async () => {
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: 'a'.repeat(64), status: 'pending-release', reservation_expires_at: null
      }])
      const res = await app.fetch(new Request('http://localhost/api/username/check/alice'), { DB: db }, createExecutionContext())
      expect(await res.json()).toEqual(expect.objectContaining({ available: false, code: 'taken', reason: 'Username is already taken' }))
      const secondResponse = await app.fetch(new Request('http://localhost/api/username/check/alice'), { DB: db }, createExecutionContext())
      expect(JSON.stringify(await secondResponse.json())).not.toContain('pending-release')
    })

    it('does not disclose that an unavailable name is held after deletion', async () => {
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: null, status: 'held', reservation_expires_at: null
      }])

      const response = await app.fetch(new Request('http://localhost/api/username/check/alice'), { DB: db }, createExecutionContext())
      const json = await response.json()

      expect(json).toEqual(expect.objectContaining({ available: false, code: 'taken', reason: 'Username is already taken' }))
      expect(JSON.stringify(json)).not.toContain('held')
    })

    it('should normalize active username pubkey to lowercase', async () => {
      const app = createTestApp()
      const ownerPubkeyUpper = 'A'.repeat(64)
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: ownerPubkeyUpper, status: 'active', reservation_expires_at: null
      }])

      const req = new Request('http://localhost/api/username/check/alice', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(false)
      expect(json.status).toBe('active')
      expect(json.pubkey).toBe(ownerPubkeyUpper.toLowerCase())
    })

    it('should not return pubkey for reserved username', async () => {
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'bob', username_display: 'bob', username_canonical: 'bob',
        pubkey: null, status: 'reserved', reservation_expires_at: null
      }])

      const req = new Request('http://localhost/api/username/check/bob', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(false)
      expect(json.status).toBe('reserved')
      expect(json.code).toBe('reserved')
      expect(json.pubkey).toBeUndefined()
    })

    it('should return code:reserved for reserved word', async () => {
      const app = createTestApp()
      // Create a mock DB where reserved_words returns a hit
      const db = createMockDB()
      const originalPrepare = db.prepare.bind(db)
      ;(db as any).prepare = (sql: string) => {
        const stmt = originalPrepare(sql)
        if (sql.includes('reserved_words')) {
          // The blocklist is read whole, without bind, so each word can be
          // matched under its own rules. `admin` at the default scope blocks
          // the name `admin`.
          const row = {
            word: 'admin',
            category: 'system',
            match_scope: 'whole',
            match_leet: 1,
            match_digit_expand: 0,
            match_repeats: 0,
            match_plain: 0,
          }
          return {
            all: async () => ({ results: [row] }),
            bind: (...params: any[]) => ({
              first: async () => ({ word: params[0] }),
              all: async () => ({ results: [row] }),
              run: async () => ({ success: true, meta: { changes: 0 } })
            })
          }
        }
        return stmt
      }

      const req = new Request('http://localhost/api/username/check/admin', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(false)
      expect(json.code).toBe('reserved')
      expect(json.reason).toBe('Username is reserved')
    })

    it('should preserve display case in response', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/check/CreatorExample', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.name).toBe('CreatorExample')
      expect(json.canonical).toBe('creatorexample')
    })
  })

  describe('GET /by-pubkey/:pubkey - Lookup by Pubkey', () => {
    it('should return found:false for unknown pubkey', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const pubkey = 'a'.repeat(64)
      const req = new Request(`http://localhost/api/username/by-pubkey/${pubkey}`, {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.found).toBe(false)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should reject invalid pubkey format', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/by-pubkey/invalidpubkey', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, createExecutionContext())
      expect(res.status).toBe(400)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('Invalid pubkey format')
    })
  })
})

describe('Public Name Reservation', () => {
  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database; SENDGRID_API_KEY?: string; ALLOWED_MINTS?: string; NAME_PRICE_JSON?: string; INVITE_FAUCET_URL?: string } }>()
    app.route('/api/username', username)
    return app
  }

  // Build a valid mock cashuA token for tests
  function mockCashuToken(amount: number = 2000, mint: string = 'https://testmint.example.com'): string {
    const payload = {
      token: [{ mint, proofs: [{ amount, id: 'test-id', secret: `secret-${Date.now()}-${Math.random()}`, C: 'test-C-value' }] }],
      unit: 'sat'
    }
    // base64url encode
    const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `cashuA${b64}`
  }

  const mockEnv = createExecutionContext()

  describe('POST /reserve - Reserve username with email', () => {
    it('should create a reservation for an available username', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'alice@example.com', cashu_token: mockCashuToken() })
      })

      const res = await app.fetch(req, { DB: db, ALLOWED_MINTS: 'https://testmint.example.com' }, mockEnv)
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.name).toBe('alice')
      expect(json.canonical).toBe('alice')
      expect(json.message).toContain('email')
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should preserve display case in reservation', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'AliceInWonderland', email: 'alice@example.com', cashu_token: mockCashuToken() })
      })

      const res = await app.fetch(req, { DB: db, ALLOWED_MINTS: 'https://testmint.example.com' }, mockEnv)
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.name).toBe('AliceInWonderland')
      expect(json.canonical).toBe('aliceinwonderland')
    })

    it('should reject missing name', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(400)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('name')
    })

    it('should reject missing email', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(400)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('email')
    })

    it('should reject invalid email format', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'not-an-email' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(400)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('email')
    })

    it('should reject invalid username format', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice_bad', email: 'alice@example.com' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(400)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
    })

    it('should reject reservation of an active username', async () => {
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: 'a'.repeat(64), status: 'active', reservation_expires_at: null
      }])

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'alice@example.com' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(409)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('already taken')
    })

    it('fails closed when reserving a pending-release username', async () => {
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: 'a'.repeat(64), status: 'pending-release', reservation_expires_at: null
      }])
      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'alice@example.com' })
      })
      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(409)
    })

    it('should reject reservation of a confirmed-reserved username', async () => {
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: null, status: 'reserved', reservation_expires_at: null
      }])

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'alice@example.com' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(409)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
    })

    it('should reject reservation of a pending-confirmation username', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 86400
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: null, status: 'pending-confirmation', reservation_expires_at: futureExpiry
      }])

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'alice@example.com' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(409)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('pending email confirmation')
    })

    it('should allow reservation when pending-confirmation has expired', async () => {
      const pastExpiry = Math.floor(Date.now() / 1000) - 86400
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: null, status: 'pending-confirmation', reservation_expires_at: pastExpiry
      }])

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', email: 'newalice@example.com', cashu_token: mockCashuToken() })
      })

      const res = await app.fetch(req, { DB: db, ALLOWED_MINTS: 'https://testmint.example.com' }, mockEnv)
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
    })

    it('should rate-limit to 5 reservations per email per hour', async () => {
      const app = createTestApp()
      // Pre-populate 5 reservation tokens for the same email
      const db = createMockDB()
      const now = Math.floor(Date.now() / 1000)
      const internalDB = db as any
      for (let i = 0; i < 5; i++) {
        internalDB._mockReservationTokens.push({
          id: i + 1,
          token: `token-${i}`,
          username_canonical: `user${i}`,
          email: 'spammer@example.com',
          created_at: now - 100,
          confirmed_at: null,
          expires_at: now + 86400
        })
      }

      const req = new Request('http://localhost/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'newname', email: 'spammer@example.com' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(429)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('Too many')
    })
  })

  describe('GET /confirm - Confirm reservation via token', () => {
    it('should confirm a valid pending reservation', async () => {
      const app = createTestApp()
      const futureExpiry = Math.floor(Date.now() / 1000) + 86400
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: null, status: 'pending-confirmation', reservation_expires_at: futureExpiry,
        confirmation_token: 'valid-token-123'
      }])
      const internalDB = db as any
      internalDB._mockReservationTokens.push({
        id: 1, token: 'valid-token-123', username_canonical: 'alice',
        email: 'alice@example.com', created_at: Math.floor(Date.now() / 1000) - 60,
        confirmed_at: null, expires_at: futureExpiry
      })

      const req = new Request('http://localhost/api/username/confirm?token=valid-token-123', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.canonical).toBe('alice')
      expect(json.subscription_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should reject missing token', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/confirm', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(400)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('token')
    })

    it('should reject unknown token', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/confirm?token=nonexistent', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(404)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
    })

    it('should reject an already-confirmed token', async () => {
      const app = createTestApp()
      const db = createMockDB()
      const internalDB = db as any
      internalDB._mockReservationTokens.push({
        id: 1, token: 'already-used', username_canonical: 'alice',
        email: 'alice@example.com', created_at: Math.floor(Date.now() / 1000) - 3600,
        confirmed_at: Math.floor(Date.now() / 1000) - 1800,
        expires_at: Math.floor(Date.now() / 1000) + 86400
      })

      const req = new Request('http://localhost/api/username/confirm?token=already-used', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(409)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('already been used')
    })

    it('should reject an expired token', async () => {
      const app = createTestApp()
      const db = createMockDB()
      const internalDB = db as any
      const pastExpiry = Math.floor(Date.now() / 1000) - 3600
      internalDB._mockReservationTokens.push({
        id: 1, token: 'expired-token', username_canonical: 'alice',
        email: 'alice@example.com', created_at: Math.floor(Date.now() / 1000) - 90000,
        confirmed_at: null, expires_at: pastExpiry
      })

      const req = new Request('http://localhost/api/username/confirm?token=expired-token', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(410)
      const json = await res.json() as any
      expect(json.ok).toBe(false)
      expect(json.error).toContain('expired')
    })
  })

  describe('POST /claim - pending-confirmation blocks claiming', () => {
    let verifyNip98Event: any

    beforeEach(async () => {
      const nip98Module = await import('../middleware/nip98')
      verifyNip98Event = nip98Module.verifyNip98Event
      vi.mocked(verifyNip98Event).mockResolvedValue('testpubkey123')
    })

    it('should block claiming a pending-confirmation username', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 86400
      const app = createTestApp()
      const db = createMockDB([{
        id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
        pubkey: null, status: 'pending-confirmation', reservation_expires_at: futureExpiry
      }])

      const req = new Request('http://localhost/api/username/claim', {
        method: 'POST',
        headers: {
          'Authorization': 'Nostr base64...',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'alice' })
      })

      const res = await app.fetch(req, { DB: db }, mockEnv)
      expect(res.status).toBe(409)
      const json = await res.json() as any
      expect(json.error).toContain('pending email confirmation')
    })
  })
})

describe('POST /release - burn own username', () => {
  let verifyNip98Event: any

  beforeEach(async () => {
    const nip98Module = await import('../middleware/nip98')
    verifyNip98Event = nip98Module.verifyNip98Event
    vi.mocked(verifyNip98Event).mockResolvedValue(
      '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b'
    )
  })

  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database } }>()
    app.route('/api/username', username)
    return app
  }

  const ctx = createExecutionContext()

  function releaseReq(name: string) {
    return new Request('http://localhost/api/username/release', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    })
  }

  it('burns the caller\'s own active name', async () => {
    const { deleteUsernameFromFastly } = await import('../utils/fastly-sync')
    vi.mocked(deleteUsernameFromFastly).mockClear()
    const app = createTestApp()
    const db = createMockDB([{
      name: 'alice', username_display: 'alice', username_canonical: 'alice',
      pubkey: '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b',
      status: 'active', recyclable: 1,
    }])
    const res = await app.fetch(releaseReq('alice'), { DB: db }, ctx)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json).toMatchObject({ ok: true, released: true, name: 'alice', status: 'burned' })

    // The row is actually burned (not merely revoked) and de-synced from
    // Fastly, so a burn->revoke regression or a dropped Fastly delete fails here.
    const row = (db as any)._mockUsernames.find(
      (u: any) => u.username_canonical === 'alice'
    )
    expect(row.status).toBe('burned')
    expect(row.recyclable).toBe(0)
    expect(deleteUsernameFromFastly).toHaveBeenCalledWith(
      expect.anything(),
      'alice'
    )
    // Pin the signed NIP-98 contract the client depends on: exact absolute
    // URL, POST, raw unmodified body, and the wider release window.
    expect(verifyNip98Event).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      'http://localhost/api/username/release',
      JSON.stringify({ name: 'alice' }),
      300
    )
  })

  it('burns a legacy underscore name (no claim-time char gate)', async () => {
    const app = createTestApp()
    const db = createMockDB([{
      name: 'the_funny_vine', username_display: 'the_funny_vine',
      username_canonical: 'the_funny_vine',
      pubkey: '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b',
      status: 'active', recyclable: 1,
    }])
    const res = await app.fetch(releaseReq('the_funny_vine'), { DB: db }, ctx)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json).toMatchObject({ released: true, status: 'burned' })
    const row = (db as any)._mockUsernames.find(
      (u: any) => u.username_canonical === 'the_funny_vine'
    )
    expect(row.status).toBe('burned')
  })

  it('burns a Unicode name via its stored punycode canonical', async () => {
    const app = createTestApp()
    const db = createMockDB([{
      name: 'Café', username_display: 'Café', username_canonical: 'xn--caf-dma',
      pubkey: '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b',
      status: 'active', recyclable: 1,
    }])
    // Client sends the stored canonical (round-trip-safe for legacy shapes).
    const res = await app.fetch(releaseReq('xn--caf-dma'), { DB: db }, ctx)
    expect(res.status).toBe(200)
    const row = (db as any)._mockUsernames.find(
      (u: any) => u.username_canonical === 'xn--caf-dma'
    )
    expect(row.status).toBe('burned')
  })

  it('does not collaterally burn another user\'s row via OR-name', async () => {
    const attackerPubkey =
      '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b'
    const victimPubkey =
      '345352a677feb41d624589f2169278dbd5a25ba940663f2020101d30a09ef96f'
    const app = createTestApp()
    const db = createMockDB([
      // Attacker owns a legacy row where name != canonical.
      {
        name: 'Alice2', username_display: 'Alice2', username_canonical: 'alice',
        pubkey: attackerPubkey, status: 'active', recyclable: 1,
      },
      // A different user's active row whose display name equals the attacker's
      // canonical — the exact collision the OR-name clause would burn.
      {
        name: 'alice', username_display: 'alice', username_canonical: 'alice-v',
        pubkey: victimPubkey, status: 'active', recyclable: 1,
      },
    ])
    // beforeEach mocks verifyNip98Event -> attackerPubkey.
    const res = await app.fetch(releaseReq('alice'), { DB: db }, ctx)
    expect(res.status).toBe(200)

    const attacker = (db as any)._mockUsernames.find(
      (u: any) => u.username_canonical === 'alice'
    )
    const victim = (db as any)._mockUsernames.find(
      (u: any) => u.username_canonical === 'alice-v'
    )
    expect(attacker.status).toBe('burned') // caller's own row is burned
    expect(victim.status).toBe('active') // the foreign row is untouched
  })

  it('returns 403 when the caller owns a different active name', async () => {
    const app = createTestApp()
    const db = createMockDB([{
      name: 'bob', username_display: 'bob', username_canonical: 'bob',
      pubkey: '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b',
      status: 'active',
    }])
    const res = await app.fetch(releaseReq('alice'), { DB: db }, ctx)
    expect(res.status).toBe(403)
  })

  it('returns 200 no-op when the caller owns no active name', async () => {
    const app = createTestApp()
    const db = createMockDB([])
    const res = await app.fetch(releaseReq('alice'), { DB: db }, ctx)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json).toMatchObject({ ok: true, released: false, reason: 'no_active_name' })
  })

  it('returns 401 on NIP-98 failure', async () => {
    vi.mocked(verifyNip98Event).mockRejectedValue(
      Object.assign(new Error('bad auth'), { name: 'Nip98Error' })
    )
    const app = createTestApp()
    const db = createMockDB([])
    const res = await app.fetch(releaseReq('alice'), { DB: db }, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid bodies', async () => {
    const app = createTestApp()
    const db = createMockDB([])
    const badBodies = [
      JSON.stringify({}), // missing name
      JSON.stringify({ name: 123 }), // non-string name
      'null', // JSON null
      '{not valid json' // malformed JSON
    ]
    for (const body of badBodies) {
      const req = new Request('http://localhost/api/username/release', {
        method: 'POST',
        headers: {
          'Authorization': 'Nostr base64...',
          'Content-Type': 'application/json'
        },
        body
      })
      const res = await app.fetch(req, { DB: db }, ctx)
      expect(res.status, `body=${body}`).toBe(400)
    }
  })

  it('a burned name can no longer be claimed by anyone', async () => {
    const app = createTestApp()
    const db = createMockDB([{
      name: 'alice', username_display: 'alice', username_canonical: 'alice',
      pubkey: '156dd13a1f8a488037fa1b43ad934a5e58644a1d6e1ad6697a02c2e93b8b013b',
      status: 'active', recyclable: 1,
    }])

    const burn = await app.fetch(releaseReq('alice'), { DB: db }, ctx)
    expect(burn.status).toBe(200)

    // A different user tries to claim the now-burned name.
    vi.mocked(verifyNip98Event).mockResolvedValue(
      '345352a677feb41d624589f2169278dbd5a25ba940663f2020101d30a09ef96f'
    )
    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'alice' })
    })
    const claim = await app.fetch(claimReq, { DB: db }, ctx)
    expect(claim.status).toBe(403)
    const json = await claim.json() as any
    expect(json.error).toContain('permanently unavailable')
  })
})

describe('GET /api/username/lookup/:name', () => {
  const fixturePubkey = 'ab'.repeat(32)
  const createLookupApp = () => {
    const app = new Hono()
    app.route('/api/username', username)
    return app
  }

  it('returns active username routing metadata including relays and atproto fields', async () => {
    const app = createLookupApp()
    const db = createMockDB([{
      name: 'Alice',
      username_display: 'Alice',
      username_canonical: 'alice',
      pubkey: 'ABCDEF1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      relays: JSON.stringify(['wss://relay.divine.video']),
      status: 'active',
      atproto_did: 'did:plc:alice123',
      atproto_state: 'ready',
    }])

    const res = await app.fetch(new Request('http://localhost/api/username/lookup/Alice'), { DB: db })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({
      pubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      relays: ['wss://relay.divine.video'],
      status: 'active',
      atproto_did: 'did:plc:alice123',
      atproto_state: 'ready',
    })
  })

  it('falls back to dotless username when dotted name is not found', async () => {
    const app = createLookupApp()
    const db = createMockDB([{
      name: 'samplecreator',
      username_display: 'samplecreator',
      username_canonical: 'samplecreator',
      pubkey: fixturePubkey,
      relays: null,
      status: 'active',
      atproto_did: null,
      atproto_state: null,
    }, {
      name: 'cool_dudethe-artist',
      username_canonical: 'cool_dudethe-artist',
      pubkey: 'cd'.repeat(32),
      status: 'active',
    }, {
      name: 'threepartname',
      username_canonical: 'threepartname',
      pubkey: 'ef'.repeat(32),
      status: 'active',
    }])

    const res = await app.fetch(new Request('http://localhost/api/username/lookup/sample.creator'), { DB: db })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.pubkey).toBe(fixturePubkey)
    expect(body.relays).toEqual([])
    expect(body.atproto_did).toBeNull()

    // Alias segments can hold underscores and hyphens, as legacy names do.
    const segmented = await app.request('/api/username/lookup/cool_dude.the-artist', {}, { DB: db })
    expect(segmented.status).toBe(200)
    expect(await segmented.json()).toMatchObject({ pubkey: 'cd'.repeat(32) })

    // Every dot is stripped, not only the first.
    const multiDot = await app.request('/api/username/lookup/three.part.name', {}, { DB: db })
    expect(multiDot.status).toBe(200)
    expect(await multiDot.json()).toMatchObject({ pubkey: 'ef'.repeat(32) })
  })

  it('returns 404 with no-store for unknown, inactive, or invalid usernames', async () => {
    const app = createLookupApp()
    const db = createMockDB([
      {
        name: 'revokeduser',
        username_canonical: 'revokeduser',
        pubkey: fixturePubkey,
        status: 'revoked',
      },
      {
        name: 'reserveduser',
        username_canonical: 'reserveduser',
        pubkey: null,
        status: 'reserved',
      },
      { name: 'nokeyuser', username_canonical: 'nokeyuser', pubkey: null, status: 'active' },
      // Active rows the malformed dotted targets would reach if they got a dotless alias.
      { name: 'alice', username_canonical: 'alice', pubkey: fixturePubkey, status: 'active' },
      { name: 'ab', username_canonical: 'ab', pubkey: fixturePubkey, status: 'active' },
      { name: 'name_', username_canonical: 'name_', pubkey: fixturePubkey, status: 'active' },
    ])

    for (const target of ['unknownuser', 'revokeduser', 'reserveduser', 'nokeyuser', 'bad--name!!', 'a..b', 'name_.', '.alice', '.alice.', '..alice']) {
      const res = await app.fetch(new Request(`http://localhost/api/username/lookup/${encodeURIComponent(target)}`), { DB: db })
      expect(res.status, target).toBe(404)
      expect(res.headers.get('cache-control'), target).toBe('no-store')
    }
  })

  // Claim rules describe new names, not every stored row: older rules, imports
  // and IDNA mapping at /claim have all stored active names shaped like these.
  it('finds active names whose stored form breaks the current claim rules', async () => {
    const app = createLookupApp()
    const names = ['-samplename', 'ab--cd', 'legacyname-']
    const db = createMockDB(names.map((name, i) => ({
      name,
      username_canonical: name,
      pubkey: String(i + 1).repeat(64),
      status: 'active',
    })))

    for (const [i, name] of names.entries()) {
      const res = await app.request(`/api/username/lookup/${encodeURIComponent(name)}`, {}, { DB: db })
      expect(res.status, name).toBe(200)
      expect(res.headers.get('cache-control'), name).toBe('public, max-age=60')
      expect(await res.json(), name).toMatchObject({ pubkey: String(i + 1).repeat(64) })
    }
  })

  // The old importer deleted characters in place and cut names at 63 characters,
  // so it could store consecutive dots or a trailing dot. Those rows match exactly;
  // only well-formed dotted names fall back to a dotless alias.
  it('finds active dotted names outside the alias grammar by exact match only', async () => {
    const app = createLookupApp()
    const db = createMockDB([
      { name: 'first..last', username_canonical: 'first..last', pubkey: fixturePubkey, status: 'active' },
      { name: 'trailing.', username_canonical: 'trailing.', pubkey: 'ef'.repeat(32), status: 'active' },
      { name: 'otherlast', username_canonical: 'otherlast', pubkey: 'cd'.repeat(32), status: 'active' },
    ])

    for (const [name, pubkey] of [['first..last', fixturePubkey], ['trailing.', 'ef'.repeat(32)]] as const) {
      const res = await app.request(`/api/username/lookup/${encodeURIComponent(name)}`, {}, { DB: db })
      expect(res.status, name).toBe(200)
      expect(await res.json(), name).toMatchObject({ pubkey })
    }

    const noAlias = await app.request(`/api/username/lookup/${encodeURIComponent('other..last')}`, {}, { DB: db })
    expect(noAlias.status).toBe(404)
  })

  it('rejects IDNA full stops before accessing the database', async () => {
    const app = createLookupApp()
    const db = createMockDB([{ name: 'alice', username_canonical: 'alice', pubkey: fixturePubkey, status: 'active' }])
    const prepare = vi.spyOn(db, 'prepare')

    // IDNA maps each of these to '.', and the canonical form keeps only the first
    // label, so without the guard 'alice' + separator + 'evil' would resolve as alice.
    for (const separator of ['\u3002', '\uff0e', '\uff61']) {
      for (const name of [separator, `alice${separator}evil`]) {
        const res = await app.request(`/api/username/lookup/${encodeURIComponent(name)}`, {}, { DB: db })
        expect(res.status, name).toBe(404)
        expect(res.headers.get('cache-control'), name).toBe('no-store')
      }
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('resolves a single Unicode label by its canonical username', async () => {
    const app = createLookupApp()
    const db = createMockDB([{
      username_canonical: 'xn--caf-dma',
      pubkey: fixturePubkey,
      status: 'active',
    }])
    const res = await app.request(`/api/username/lookup/${encodeURIComponent('Café')}`, {}, { DB: db })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pubkey: fixturePubkey })
  })

  // A canonical lookup misses a stored name it does not cover, such as a Unicode
  // name held as typed; /.well-known/webfinger also retries the name as given.
  it('retries the name as given when its canonical form is not stored', async () => {
    const app = createLookupApp()
    const db = createMockDB([{ name: 'crème', username_canonical: 'crème', pubkey: fixturePubkey, status: 'active' }])

    const res = await app.request(`/api/username/lookup/${encodeURIComponent('crème')}`, {}, { DB: db })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pubkey: fixturePubkey })
  })

  // The canonical form is tried first, and a non-active canonical match ends the
  // search rather than falling through to a row stored under the name as typed.
  it('prefers the canonical match and stops at a non-active one', async () => {
    const app = createLookupApp()
    const asTyped = { name: 'crème', username_canonical: 'crème', pubkey: 'cd'.repeat(32), status: 'active' }
    const canonicalRow = (status: string) =>
      ({ name: 'xn--crme-6oa', username_canonical: 'xn--crme-6oa', pubkey: fixturePubkey, status })
    const lookup = (rows: any[]) =>
      app.request(`/api/username/lookup/${encodeURIComponent('crème')}`, {}, { DB: createMockDB(rows) })

    const active = await lookup([canonicalRow('active'), asTyped])
    expect(active.status).toBe(200)
    expect(await active.json()).toMatchObject({ pubkey: fixturePubkey })

    const revoked = await lookup([canonicalRow('revoked'), asTyped])
    expect(revoked.status).toBe(404)
  })

  it('resolves legacy underscore usernames and withholds non-ready atproto state/DID', async () => {
    const app = createLookupApp()
    const db = createMockDB([{
      name: 'legacy_user',
      username_display: 'legacy_user',
      username_canonical: 'legacy_user',
      pubkey: fixturePubkey,
      relays: '{malformed json',
      status: 'active',
      atproto_did: 'did:plc:pending123',
      atproto_state: 'pending',
    }])

    const res = await app.fetch(new Request('http://localhost/api/username/lookup/legacy_user'), { DB: db })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      pubkey: fixturePubkey,
      relays: [],
      status: 'active',
      atproto_did: null,
      atproto_state: null,
    })
  })

  it('does not fall back to active dotless user when dotted name exists as non-active', async () => {
    const app = createLookupApp()
    const db = createMockDB([
      {
        name: 'john.doe',
        username_canonical: 'john.doe',
        pubkey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'revoked',
      },
      {
        name: 'johndoe',
        username_canonical: 'johndoe',
        pubkey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        status: 'active',
      },
    ])

    const res = await app.fetch(new Request('http://localhost/api/username/lookup/john.doe'), { DB: db })
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('answers a database failure with an uncached 500', async () => {
    const app = createLookupApp()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { prepare: () => { throw new Error('D1 unavailable') } }

    const res = await app.request('/api/username/lookup/alice', {}, { DB: db })
    consoleError.mockRestore()
    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
