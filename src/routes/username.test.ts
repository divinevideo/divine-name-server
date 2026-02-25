// ABOUTME: Tests for username claiming with case-insensitive matching
// ABOUTME: Ensures canonical usernames prevent collisions and preserve display case

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import username from './username'

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
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true })
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
              if (sql.includes('pubkey = ?')) {
                const pubkey = boundParams[0]
                return mockUsernames.find(u => u.pubkey === pubkey && u.status === 'active') || null
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
        }
      }
    },
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
      body: JSON.stringify({ name: 'MrBeast' })
    })
    
    const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.name).toBe('MrBeast') // Display name preserved
  })

  it('should prevent case-insensitive collisions', async () => {
    const app = createTestApp()
    const db = createMockDB()

    // First claim: MrBeast
    const req1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'MrBeast' })
    })

    const res1 = await app.fetch(req1, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
    expect(res1.status).toBe(200)

    // Second claim: mrbeast (should fail)
    vi.mocked(verifyNip98Event).mockResolvedValue('differentpubkey456')
    const req2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Nostr base64...',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'mrbeast' })
    })

    const res2 = await app.fetch(req2, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
    expect(res2.status).toBe(409) // Conflict
    const json2 = await res2.json() as any
    expect(json2.error).toBe('That username is already taken')
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
    
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })
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
    
    const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

    const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

    await app.fetch(req1, { DB: db }, { waitUntil: (p: Promise<any>) => { waitUntilCalls.push(p) }, passThroughOnException: () => {} })

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

    const res2 = await app.fetch(req2, { DB: db }, { waitUntil: (p: Promise<any>) => { waitUntilCalls.push(p) }, passThroughOnException: () => {} })
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

      const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

      const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.ok).toBe(true)
      expect(json.available).toBe(false)
      expect(json.reason).toContain('underscores')
    })

    it('should preserve display case in response', async () => {
      const app = createTestApp()
      const db = createMockDB()

      const req = new Request('http://localhost/api/username/check/MrBeast', {
        method: 'GET'
      })

      const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.name).toBe('MrBeast')
      expect(json.canonical).toBe('mrbeast')
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

      const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

      const res = await app.fetch(req, { DB: db }, { waitUntil: () => {}, passThroughOnException: () => {} })
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

  const mockEnv = { waitUntil: () => {}, passThroughOnException: () => {} }

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

