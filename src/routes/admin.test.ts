// ABOUTME: Tests for admin endpoints
// ABOUTME: Validates search endpoint input validation, error handling, and hostname auth guard

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'

// Mock the email utility so tests don't hit SendGrid
vi.mock('../utils/email', () => ({
  sendAssignmentNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendReservationConfirmationEmail: vi.fn().mockResolvedValue(undefined)
}))

// Mock D1 database
function createMockDB() {
  const mockResults = [
    {
      id: 1,
      name: 'testuser',
      username_display: 'testuser',
      username_canonical: 'testuser',
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

  return {
    prepare: (sql: string) => {
      let boundParams: any[] = []
      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
              if (sql.includes('COUNT(*)')) {
                let filtered = [...mockResults]
                const hasSearchPattern = sql.includes('LIKE')
                
                if (hasSearchPattern) {
                  const searchPattern = boundParams[0]
                  if (searchPattern && typeof searchPattern === 'string') {
                    const searchTerm = searchPattern.replace(/%/g, '').replace(/\\/g, '')
                    if (searchTerm.length > 0) {
                      filtered = mockResults.filter(u =>
                        (u.name && u.name.includes(searchTerm)) ||
                        (u.username_display && u.username_display.includes(searchTerm)) ||
                        (u.username_canonical && u.username_canonical.includes(searchTerm)) ||
                        (u.pubkey && u.pubkey.includes(searchTerm)) ||
                        (u.email && u.email.includes(searchTerm))
                      )
                    }
                  }
                  
                  // Status is at index 5 if search pattern exists
                  if (boundParams.length > 7 && typeof boundParams[5] === 'string') {
                    filtered = filtered.filter(u => u.status === boundParams[5])
                  }
                } else {
                  // No search pattern - check for status filter
                  if (sql.includes('status = ?') && boundParams.length > 0 && boundParams[0]) {
                    filtered = filtered.filter(u => u.status === boundParams[0])
                  }
                }
                
                return { count: filtered.length }
              }
              
              // Check for existing username lookup
              if (sql.includes('username_canonical = ?') || sql.includes('name = ?')) {
                const lookupValue = boundParams[0] || boundParams[1]
                const found = mockResults.find(u => 
                  u.username_canonical === lookupValue || u.name === lookupValue
                )
                return found || null
              }
              
              // Check for reserved_words lookup (in first() - this is for isReservedWord)
              if (sql.includes('reserved_words') && sql.includes('SELECT 1')) {
                return null // Not reserved by default
              }
              
              return null
            },
            all: async () => {
              // Handle reserved_words queries
              if (sql.includes('reserved_words')) {
                return { results: [] }
              }
              
              let filtered = [...mockResults]
              const hasSearchPattern = sql.includes('LIKE')
              
              if (hasSearchPattern) {
                const searchPattern = boundParams[0]
                if (searchPattern && typeof searchPattern === 'string') {
                  const searchTerm = searchPattern.replace(/%/g, '').replace(/\\/g, '')
                  if (searchTerm.length > 0) {
                    filtered = mockResults.filter(u =>
                      (u.name && u.name.includes(searchTerm)) ||
                      (u.username_display && u.username_display.includes(searchTerm)) ||
                      (u.username_canonical && u.username_canonical.includes(searchTerm)) ||
                      (u.pubkey && u.pubkey.includes(searchTerm)) ||
                      (u.email && u.email.includes(searchTerm))
                    )
                  }
                }
                
                // Status is at index 5 if search pattern exists
                if (boundParams.length > 7 && typeof boundParams[5] === 'string') {
                  filtered = filtered.filter(u => u.status === boundParams[5])
                }
              } else {
                // No search pattern - check for status filter
                if (sql.includes('status = ?') && boundParams.length > 0 && boundParams[0]) {
                  filtered = filtered.filter(u => u.status === boundParams[0])
                }
              }
              
              // Apply pagination
              const limit = boundParams[boundParams.length - 2] || 50
              const offset = boundParams[boundParams.length - 1] || 0
              
              return {
                results: filtered
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit)
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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('required')
  })

  it('should allow empty query string to return all results', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.results).toBeDefined()
    expect(json.pagination).toBeDefined()
  })

  it('should allow empty query with status filter', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=&status=active')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.results).toBeDefined()
  })

  it('should return 400 if query is too long', async () => {
    const app = createTestApp()

    const longQuery = 'a'.repeat(101)
    const req = new Request(`http://localhost/admin/usernames/search?q=${longQuery}`)
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('100 characters or less')
  })

  it('should return successful search with valid query', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.results).toBeDefined()
    expect(json.pagination).toBeDefined()
    expect(json.pagination.page).toBe(1)
    expect(json.pagination.limit).toBe(50)
  })

  it('should return 400 if status parameter is invalid', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&status=invalid')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Invalid status parameter')
  })

  it('should return 400 if page is negative', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=-1')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if page is zero', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=0')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if page is not a number', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&page=abc')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Page must be a positive integer')
  })

  it('should return 400 if limit is negative', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=-1')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return 400 if limit is zero', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=0')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return 400 if limit is not a number', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=test&limit=xyz')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Limit must be a positive integer')
  })

  it('should return all results with empty query and no status filter', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.results).toBeDefined()
    expect(json.pagination).toBeDefined()
    expect(json.pagination.total).toBe(1) // Mock has 1 result
  })

  it('should return filtered results with empty query and status filter', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=&status=active')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.results).toBeDefined()
  })

  it('should handle empty query with pagination', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=&page=1&limit=10')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.pagination.page).toBe(1)
    expect(json.pagination.limit).toBe(10)
  })

  it('should handle single character query (no minimum requirement)', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/usernames/search?q=a')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.results).toBeDefined()
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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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

    // alice_123 is invalid (contains underscore)
    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: 'alice_123' })
    })
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.total).toBe(1)

    // Check that alice_123 failed validation
    const result = json.results[0]
    expect(result.name).toBe('alice_123')
    expect(result.success).toBe(false)
    expect(result.error).toContain('underscores')
  })

  it('should strip @ symbols from usernames', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/admin/username/reserve-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: '@alice,@bob,@@charlie' })
    })
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

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

describe('Admin Notify Assignment Endpoint', () => {
  // DB that returns an active username for 'testuser' and null for unknown names
  function createNotifyMockDB(status: string = 'active') {
    return {
      prepare: (sql: string) => ({
        bind: (...params: any[]) => ({
          first: async () => {
            if (sql.includes('username_canonical') || sql.includes('name = ?')) {
              const lookup = params[0]
              if (lookup === 'testuser') {
                return {
                  id: 1,
                  name: 'testuser',
                  username_display: 'testuser',
                  username_canonical: 'testuser',
                  pubkey: 'abc123',
                  email: null,
                  relays: null,
                  status,
                  recyclable: 0,
                  created_at: 1700000000,
                  updated_at: 1700000000,
                  claimed_at: 1700000000,
                  revoked_at: null,
                  reserved_reason: null,
                  admin_notes: null
                }
              }
              return null
            }
            return null
          },
          all: async () => ({ results: [] }),
          run: async () => ({ success: true })
        })
      })
    } as unknown as D1Database
  }

  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database; SENDGRID_API_KEY?: string } }>()
    app.route('/admin', admin)
    return app
  }

  it('should return 400 if name is missing', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB(), SENDGRID_API_KEY: 'test-key' }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Name is required')
  })

  it('should return 400 if email is missing', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testuser' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB(), SENDGRID_API_KEY: 'test-key' }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Email is required')
  })

  it('should return 400 if email is invalid', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testuser', email: 'not-an-email' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB(), SENDGRID_API_KEY: 'test-key' }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Invalid email address')
  })

  it('should return 404 if username does not exist', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nonexistent', email: 'user@example.com' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB(), SENDGRID_API_KEY: 'test-key' }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(404)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('not found')
  })

  it('should return 409 if username is not active', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testuser', email: 'user@example.com' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB('reserved'), SENDGRID_API_KEY: 'test-key' }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(409)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('not active')
  })

  it('should return 503 if SendGrid API key is not configured', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testuser', email: 'user@example.com' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(503)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toContain('not configured')
  })

  it('should send notification and return success', async () => {
    const app = createTestApp()
    const req = new Request('http://localhost/admin/notify-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testuser', email: 'user@example.com' })
    })
    const res = await app.fetch(req, { DB: createNotifyMockDB(), SENDGRID_API_KEY: 'test-key' }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.name).toBe('testuser')
    expect(json.email).toBe('user@example.com')
  })
})

describe('Admin Hostname Auth Guard', () => {
  function createTestApp() {
    const app = new Hono<{ Bindings: { DB: D1Database } }>()
    app.route('/api/admin', admin)
    return app
  }

  it('should block admin API requests from names.divine.video', async () => {
    const app = createTestApp()

    const req = new Request('https://names.divine.video/api/admin/usernames/search?q=test')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(403)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
    expect(json.error).toBe('Unauthorized')
  })

  it('should block admin API requests from arbitrary hostnames', async () => {
    const app = createTestApp()

    const req = new Request('https://evil.example.com/api/admin/export/csv')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(403)
    const json = await res.json() as any
    expect(json.ok).toBe(false)
  })

  it('should block admin POST requests from non-admin hostnames', async () => {
    const app = createTestApp()

    const req = new Request('https://names.divine.video/api/admin/username/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice', pubkey: 'a'.repeat(64) })
    })
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(403)
  })

  it('should allow admin API requests from names.admin.divine.video with CF Access JWT', async () => {
    const app = createTestApp()

    const req = new Request('https://names.admin.divine.video/api/admin/usernames/search?q=test', {
      headers: { 'Cf-Access-Jwt-Assertion': 'fake-jwt-for-test' }
    })
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
  })

  it('should block admin API requests from names.admin.divine.video without CF Access JWT', async () => {
    const app = createTestApp()

    const req = new Request('https://names.admin.divine.video/api/admin/usernames/search?q=test')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(403)
  })

  it('should allow admin API requests from localhost for local dev', async () => {
    const app = createTestApp()

    const req = new Request('http://localhost/api/admin/usernames/search?q=test')
    const res = await app.fetch(req, { DB: createMockDB() }, { waitUntil: () => {}, passThroughOnException: () => {} })

    expect(res.status).toBe(200)
  })
})
