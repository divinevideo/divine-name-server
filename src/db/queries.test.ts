// ABOUTME: Tests for database query functions
// ABOUTME: Validates search functionality with mocked D1 database

import { describe, it, expect, vi } from 'vitest'
import { searchUsernames, type SearchParams, type Username } from './queries'

// Mock D1 database
function createMockDB() {
  const mockResults: Username[] = [
    {
      id: 1,
      name: 'alice',
      pubkey: 'abc123',
      email: 'alice@example.com',
      relays: null,
      status: 'active',
      recyclable: 0,
      created_at: 1700000000,
      updated_at: 1700000000,
      claimed_at: 1700000000,
      revoked_at: null,
      reserved_reason: null,
      admin_notes: null
    },
    {
      id: 2,
      name: 'bob',
      pubkey: 'def456',
      email: 'bob@example.com',
      relays: null,
      status: 'reserved',
      recyclable: 0,
      created_at: 1700000100,
      updated_at: 1700000100,
      claimed_at: null,
      revoked_at: null,
      reserved_reason: 'Test reservation',
      admin_notes: null
    },
    {
      id: 3,
      name: 'charlie',
      pubkey: 'ghi789',
      email: 'charlie@example.com',
      relays: null,
      status: 'active',
      recyclable: 0,
      created_at: 1700000200,
      updated_at: 1700000200,
      claimed_at: 1700000200,
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
              // Mock count query
              if (sql.includes('COUNT(*)')) {
                // Filter based on bound params
                let filtered = [...mockResults]
                const searchPattern = boundParams[0]

                if (searchPattern) {
                  const searchTerm = searchPattern.replace(/%/g, '').replace(/\\/g, '')
                  filtered = mockResults.filter(u =>
                    u.name.includes(searchTerm) ||
                    (u.pubkey && u.pubkey.includes(searchTerm)) ||
                    (u.email && u.email.includes(searchTerm))
                  )
                }

                // Apply status filter if present
                if (boundParams.length > 3 && boundParams[3]) {
                  filtered = filtered.filter(u => u.status === boundParams[3])
                }

                return { count: filtered.length }
              }
              return null
            },
            all: async () => {
              // Mock search query
              let filtered = [...mockResults]
              const searchPattern = boundParams[0]

              if (searchPattern) {
                const searchTerm = searchPattern.replace(/%/g, '').replace(/\\/g, '')
                filtered = mockResults.filter(u =>
                  u.name.includes(searchTerm) ||
                  (u.pubkey && u.pubkey.includes(searchTerm)) ||
                  (u.email && u.email.includes(searchTerm))
                )
              }

              // Apply status filter if present
              if (boundParams.length > 5 && boundParams[3]) {
                filtered = filtered.filter(u => u.status === boundParams[3])
              }

              // Apply pagination
              const limit = boundParams[boundParams.length - 2] || 50
              const offset = boundParams[boundParams.length - 1] || 0

              return {
                results: filtered
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit)
              }
            }
          }
        }
      }
    }
  } as unknown as D1Database
}

describe('searchUsernames', () => {
  it('should search by username', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: 'alice' }

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
    expect(result.pagination.total).toBe(1)
  })

  it('should search by pubkey', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: 'abc123' }

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].pubkey).toBe('abc123')
  })

  it('should search by email', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: 'bob@example.com' }

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].email).toBe('bob@example.com')
  })

  it('should filter by status', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', status: 'active' }

    const result = await searchUsernames(db, params)

    expect(result.results.every(u => u.status === 'active')).toBe(true)
  })

  it('should handle pagination with default values', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '' }

    const result = await searchUsernames(db, params)

    expect(result.pagination.page).toBe(1)
    expect(result.pagination.limit).toBe(50)
  })

  it('should handle custom pagination', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', page: 2, limit: 1 }

    const result = await searchUsernames(db, params)

    expect(result.pagination.page).toBe(2)
    expect(result.pagination.limit).toBe(1)
  })

  it('should calculate total pages correctly', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', limit: 2 }

    const result = await searchUsernames(db, params)

    expect(result.pagination.total).toBe(3)
    expect(result.pagination.total_pages).toBe(2) // 3 results / 2 per page = 2 pages
  })

  it('should not throw error with LIKE special characters in query', async () => {
    const db = createMockDB()

    // Test that queries with special characters don't cause issues
    // The escaping happens in searchUsernames before the LIKE pattern is used
    const params1: SearchParams = { query: 'alice%' }
    const result1 = await searchUsernames(db, params1)
    expect(result1).toBeDefined()
    expect(result1.pagination).toBeDefined()

    const params2: SearchParams = { query: 'bob_' }
    const result2 = await searchUsernames(db, params2)
    expect(result2).toBeDefined()
    expect(result2.pagination).toBeDefined()
  })

  it('should return empty results when no matches found', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: 'nonexistent' }

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(0)
    expect(result.pagination.total).toBe(0)
    expect(result.pagination.total_pages).toBe(0)
  })

  it('should handle empty query string', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '' }

    const result = await searchUsernames(db, params)

    expect(result.results.length).toBeGreaterThan(0)
  })

  it('should combine query and status filters', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: 'alice', status: 'active' }

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
    expect(result.results[0].status).toBe('active')
  })

  it('should return empty results when status filter excludes all matches', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: 'alice', status: 'reserved' }

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(0)
  })
})
