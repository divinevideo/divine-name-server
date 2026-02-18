// ABOUTME: Tests for username claiming with case-insensitive matching
// ABOUTME: Ensures canonical usernames prevent collisions and preserve display case

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import username from './username'

// Mock NIP-98 middleware
vi.mock('../middleware/nip98', () => ({
  verifyNip98Event: vi.fn()
}))

// Mock Fastly sync utilities
vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true })
}))

// Mock D1 database
function createMockDB() {
  const mockUsernames: any[] = []
  
  return {
    prepare: (sql: string) => {
      let boundParams: any[] = []
      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
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
              // Handle INSERT/UPDATE operations
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
                    email: null
                  })
                }
              }
              
              return { success: true }
            }
          }
        }
      }
    }
  } as unknown as D1Database
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

