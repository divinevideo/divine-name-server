// ABOUTME: Tests for admin endpoints
// ABOUTME: Validates search endpoint input validation and error handling

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'

// Mock D1 database
function createMockDB() {
  return {
    prepare: (sql: string) => {
      return {
        bind: (...params: any[]) => {
          return {
            first: async () => {
              if (sql.includes('COUNT(*)')) {
                return { count: 5 }
              }
              return null
            },
            all: async () => {
              return {
                results: [
                  {
                    id: 1,
                    name: 'testuser',
                    pubkey: 'abc123',
                    email: 'test@example.com',
                    relays: null,
                    status: 'active',
                    recyclable: 0,
                    created_at: 1700000000,
                    updated_at: 1700000000,
                    claimed_at: 1700000000,
                    revoked_at: null,
                    reserved_reason: null,
                    admin_notes: null
                  }
                ]
              }
            },
            run: async () => {
              return { success: true }
            }
          }
        }
      }
    }
  } as unknown as D1Database
}

describe('Admin Search Endpoint', () => {
  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database } }>()
    app.route('/admin', admin)
    return app
  }

  it('should return 400 if query parameter is missing', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('required')
  })

  it('should return 400 if query is too short', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('required')
  })

  it('should return 400 if query is too long', async () => {
    const app = createTestApp()

    const longQuery = 'a'.repeat(101)
    const req = new Request(`http://localhost/admin/usernames/search?q=${longQuery}`)
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('between 1 and 100 characters')
  })

  it('should return 400 if status parameter is invalid', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&status=invalid')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Invalid status parameter')
  })

  it('should return 400 if page is negative', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=-1')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if page is zero', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=0')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if page is not a number', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=abc')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if limit is negative', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=-1')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return 400 if limit is zero', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=0')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return 400 if limit is not a number', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=xyz')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })
})

describe('Admin Bulk Reserve Endpoint', () => {
  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database } }>()
    app.route('/admin', admin)
    return app
  }

  it('should accept comma-separated list of names', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: 'alice,bob,charlie' })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(3)
    expect(json.results.length).toBe(3)
  })

  it('should accept space-separated list of names', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: 'alice bob charlie' })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(3)
  })

  it('should accept array of names', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['alice', 'bob', 'charlie'] })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(3)
  })

  it('should handle mixed comma and space separators', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: 'alice, bob charlie,dave' })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(4)
  })

  it('should return 400 if names is missing', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('required')
  })

  it('should return 400 if names is empty string', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: '   ' }) // whitespace only
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('No valid names')
  })

  it('should return 400 if more than 1000 names', async () => {
    const app = createTestApp()

    const tooMany = Array(1001).fill('alice').join(',')
    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: tooMany })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Maximum 1000')
  })

  it('should return results with proper structure', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: 'alice,bob,charlie' })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(3)
    expect(json.results).toHaveLength(3)
    expect(json).toHaveProperty('successful')
    expect(json).toHaveProperty('failed')

    // Check result structure
    expect(json.results[0]).toHaveProperty('name')
    expect(json.results[0]).toHaveProperty('status')
    expect(json.results[0]).toHaveProperty('success')
  })

  it('should detect invalid usernames in bulk', async () => {
    const app = createTestApp()

    // ALICE is invalid (uppercase)
    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: 'ALICE' })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(1)

    // Check that ALICE failed validation
    const result = json.results[0]
    expect(result.name).toBe('ALICE')
    expect(result.success).toBe(false)
    expect(result.error).toContain('lowercase')
  })

  it('should strip @ symbols from usernames', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: '@alice,@bob,@@charlie' })
    })
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(3)

    // Check that names were stripped of @ symbols
    expect(json.results.find((r: any) => r.name === 'alice')).toBeTruthy()
    expect(json.results.find((r: any) => r.name === 'bob')).toBeTruthy()
    expect(json.results.find((r: any) => r.name === 'charlie')).toBeTruthy()
    expect(json.results.find((r: any) => r.name === '@alice')).toBeFalsy()
  })
})
