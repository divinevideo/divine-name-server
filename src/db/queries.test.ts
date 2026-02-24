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
      username_display: 'alice',
      username_canonical: 'alice',
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
      admin_notes: null,
      reservation_email: null,
      confirmation_token: null,
      reservation_expires_at: null,
      subscription_expires_at: null
    },
    {
      id: 2,
      name: 'bob',
      username_display: 'bob',
      username_canonical: 'bob',
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
      admin_notes: null,
      reservation_email: null,
      confirmation_token: null,
      reservation_expires_at: null,
      subscription_expires_at: null
    },
    {
      id: 3,
      name: 'charlie',
      username_display: 'charlie',
      username_canonical: 'charlie',
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
      admin_notes: null,
      reservation_email: null,
      confirmation_token: null,
      reservation_expires_at: null,
      subscription_expires_at: null
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
                
                // Check if WHERE clause uses LIKE patterns (has search query)
                // If WHERE clause is "1=1", there's no search pattern
                const hasSearchPattern = sql.includes('LIKE')
                
                if (hasSearchPattern) {
                  // When there's a LIKE pattern, first 5 params are search patterns (all same value)
                  // name, username_display, username_canonical, pubkey, email
                  const searchPattern = boundParams[0]
                  if (searchPattern && typeof searchPattern === 'string') {
                    // Remove LIKE wildcards and escape characters to get the actual search term
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
                  
                  // Status is at index 5 if search pattern exists (but only if it's not limit/offset)
                  // Limit and offset are always the last 2 params, so status would be at index 5
                  // only if boundParams.length > 7 (5 patterns, status, limit, offset)
                  if (boundParams.length > 7 && typeof boundParams[5] === 'string') {
                    filtered = filtered.filter(u => u.status === boundParams[5])
                  }
                } else {
                  // No search pattern - check for status filter
                  // If WHERE is "1=1", no params. If WHERE is "status = ?", param is at index 0
                  if (sql.includes('status = ?') && boundParams.length > 0 && boundParams[0]) {
                    filtered = filtered.filter(u => u.status === boundParams[0])
                  }
                  // If WHERE is "1=1", no filtering needed - return all
                }

                return { count: filtered.length }
              }
              return null
            },
            all: async () => {
              // Mock search query
              let filtered = [...mockResults]
              
              // Check if WHERE clause uses LIKE patterns (has search query)
              const hasSearchPattern = sql.includes('LIKE')
              
              if (hasSearchPattern) {
                // When there's a LIKE pattern, first 5 params are search patterns (all same value)
                // name, username_display, username_canonical, pubkey, email
                // But limit and offset are always last two, so we need to exclude them
                const searchPattern = boundParams[0]
                if (searchPattern && typeof searchPattern === 'string') {
                  // Remove LIKE wildcards and escape characters to get the actual search term
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
                
                // Status is at index 5 if search pattern exists (but only if it's not limit/offset)
                // Limit and offset are always the last 2 params, so status would be at index 5
                // only if boundParams.length > 7 (5 patterns, status, limit, offset)
                if (boundParams.length > 7 && typeof boundParams[5] === 'string') {
                  filtered = filtered.filter(u => u.status === boundParams[5])
                }
              } else {
                // No search pattern - check for status filter
                // If WHERE is "1=1", no params. If WHERE is "status = ?", param is at index 0
                if (sql.includes('status = ?') && boundParams.length > 0 && boundParams[0]) {
                  filtered = filtered.filter(u => u.status === boundParams[0])
                }
                // If WHERE is "1=1", no filtering needed - return all
              }

              // Apply pagination
              // Limit and offset are always the last two params
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

  it('should handle empty query string and return all results', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '' }

    const result = await searchUsernames(db, params)

    expect(result.results.length).toBe(3) // All 3 mock results
    expect(result.pagination.total).toBe(3)
  })

  it('should handle empty query with status filter', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', status: 'active' }

    const result = await searchUsernames(db, params)

    expect(result.results.every(u => u.status === 'active')).toBe(true)
    expect(result.results.length).toBe(2) // alice and charlie are active
    expect(result.pagination.total).toBe(2)
  })

  it('should handle empty query with reserved status filter', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', status: 'reserved' }

    const result = await searchUsernames(db, params)

    expect(result.results.every(u => u.status === 'reserved')).toBe(true)
    expect(result.results.length).toBe(1) // Only bob is reserved
    expect(result.pagination.total).toBe(1)
  })

  it('should handle empty query with pagination', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', page: 1, limit: 2 }

    const result = await searchUsernames(db, params)

    expect(result.results.length).toBe(2)
    expect(result.pagination.total).toBe(3)
    expect(result.pagination.total_pages).toBe(2)
    expect(result.pagination.page).toBe(1)
    expect(result.pagination.limit).toBe(2)
  })

  it('should handle empty query with pagination page 2', async () => {
    const db = createMockDB()
    const params: SearchParams = { query: '', page: 2, limit: 2 }

    const result = await searchUsernames(db, params)

    expect(result.results.length).toBe(1) // Only 1 result on page 2
    expect(result.pagination.total).toBe(3)
    expect(result.pagination.total_pages).toBe(2)
    expect(result.pagination.page).toBe(2)
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
