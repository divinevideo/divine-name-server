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
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('required')
  })

  it('should return 400 if query is too short', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('required')
  })

  it('should return 400 if query is too long', async () => {
    const app = createTestApp()

    const longQuery = 'a'.repeat(101)
    const req = new Request(`http://localhost/admin/usernames/search?q=${longQuery}`)
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('between 1 and 100 characters')
  })

  it('should return 400 if status parameter is invalid', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&status=invalid')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Invalid status parameter')
  })

  it('should return 400 if page is negative', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=-1')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if page is zero', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=0')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if page is not a number', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=abc')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if limit is negative', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=-1')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return 400 if limit is zero', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=0')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return 400 if limit is not a number', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=xyz')
    const res = await app.request(req, { env: { DB: createMockDB() } } as any)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })
})
