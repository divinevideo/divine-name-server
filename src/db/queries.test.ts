// ABOUTME: Tests for database query functions
// ABOUTME: Validates search functionality with mocked D1 database

import { describe, it, expect, vi } from 'vitest'
import { searchUsernames, claimUsername, createReservation, reserveUsername, type SearchParams, type Username } from './queries'

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
      admin_notes: 'VIP creator account',
      reservation_email: null,
      confirmation_token: null,
      reservation_expires_at: null,
      subscription_expires_at: null,
      claim_source: 'unknown',
      created_by: null
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
      subscription_expires_at: null,
      claim_source: 'unknown',
      created_by: null
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
      subscription_expires_at: null,
      claim_source: 'unknown',
      created_by: null
    }
  ]
  const mockTags = [
    { username_id: 1, tag_display: 'VIP', tag_normalized: 'vip' },
    { username_id: 1, tag_display: 'creator', tag_normalized: 'creator' },
    { username_id: 3, tag_display: 'support', tag_normalized: 'support' }
  ]

  const filterUsernames = (sql: string, params: any[]) => {
    let filtered = [...mockResults]
    const normalizedSql = sql.replace(/\s+/g, ' ').toLowerCase()
    const hasSearchPattern = sql.includes('LIKE')

    if (hasSearchPattern) {
      const searchPattern = params[0]
      if (searchPattern && typeof searchPattern === 'string') {
        const searchTerm = searchPattern.replace(/%/g, '').replace(/\\/g, '').toLowerCase()
        if (searchTerm.length > 0) {
          filtered = filtered.filter((u) => {
            const tags = mockTags
              .filter((tag) => tag.username_id === u.id)
              .flatMap((tag) => [tag.tag_display, tag.tag_normalized])
            const haystack = [
              u.name,
              u.username_display,
              u.username_canonical,
              u.pubkey,
              u.email,
              u.admin_notes,
              ...tags
            ]
              .filter(Boolean)
              .map((value) => String(value).toLowerCase())

            return haystack.some((value) => value.includes(searchTerm))
          })
        }
      }
    }

    const statusParam = params.find((param) => ['active', 'reserved', 'revoked', 'burned', 'recovered'].includes(param))
    if (typeof statusParam === 'string' && statusParam !== 'recovered') {
      filtered = filtered.filter((u) => u.status === statusParam)
    }

    if (normalizedSql.includes('order by created_at asc')) {
      filtered.sort((a, b) => a.created_at - b.created_at)
    } else if (normalizedSql.includes('order by updated_at desc')) {
      filtered.sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at)
    } else {
      filtered.sort((a, b) => b.created_at - a.created_at)
    }

    return filtered
  }

  return {
    prepare: (sql: string) => {
      let boundParams: any[] = []

      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
              if (sql.includes('FROM username_tags') && !sql.includes('FROM usernames')) {
                return { count: 0 }
              }

              // Mock count query
              if (sql.includes('COUNT(*)')) {
                return { count: filterUsernames(sql, boundParams).length }
              }
              return null
            },
            all: async () => {
              if (sql.includes('FROM username_tags') && !sql.includes('FROM usernames')) {
                const requestedIds = boundParams.filter((param) => typeof param === 'number')
                return {
                  results: mockTags
                    .filter((tag) => requestedIds.length === 0 || requestedIds.includes(tag.username_id))
                    .map((tag) => ({ username_id: tag.username_id, tag_display: tag.tag_display }))
                }
              }

              // Mock search query
              const filtered = filterUsernames(sql, boundParams)

              // Apply pagination
              // Limit and offset are always the last two params
              const limit = boundParams[boundParams.length - 2] || 50
              const offset = boundParams[boundParams.length - 1] || 0

              return {
                results: filtered.slice(offset, offset + limit)
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

  it('should search by internal notes', async () => {
    const db = createMockDB()
    const params = { query: 'VIP' } as SearchParams

    const result = await searchUsernames(db, params)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
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

  it('should support oldest-first sorting', async () => {
    const db = createMockDB()
    const params = { query: '', sort: 'oldest' } as SearchParams & { sort: 'oldest' }

    const result = await searchUsernames(db, params)

    expect(result.results.map((username) => username.name)).toEqual(['alice', 'bob', 'charlie'])
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

describe('claimUsername', () => {
  it('should set claim_source to self-service', async () => {
    const sqlStatements: string[] = []
    const mockDB = {
      prepare: (sql: string) => {
        sqlStatements.push(sql)
        return {
          bind: (...params: any[]) => ({
            run: async () => ({ success: true }),
          }),
        }
      },
    } as unknown as D1Database

    await claimUsername(mockDB, 'TestUser', 'testuser', 'abc123', null)

    const insertSql = sqlStatements[1] // Second call is INSERT (first is revoke UPDATE)
    expect(insertSql).toContain("'self-service'")
    expect(insertSql).toContain('claim_source')
  })
})

describe('reserveUsername', () => {
  it('should include claim_source and created_by in SQL', async () => {
    const sqlStatements: string[] = []
    const boundParams: any[][] = []
    const mockDB = {
      prepare: (sql: string) => {
        sqlStatements.push(sql)
        return {
          bind: (...params: any[]) => {
            boundParams.push(params)
            return { run: async () => ({ success: true }) }
          },
        }
      },
    } as unknown as D1Database

    await reserveUsername(mockDB, 'TestName', 'testname', 'brand protection', 'admin', 'matt@divine.video')

    expect(sqlStatements[0]).toContain('claim_source')
    expect(sqlStatements[0]).toContain('created_by')
    const allParams = boundParams.flat()
    expect(allParams).toContain('matt@divine.video')
    expect(allParams).toContain('admin')
  })
})

describe('createReservation', () => {
  it('should set claim_source to public-reservation', async () => {
    const sqlStatements: string[] = []
    const mockDB = {
      prepare: (sql: string) => {
        sqlStatements.push(sql)
        return {
          bind: (...params: any[]) => ({
            run: async () => ({ success: true }),
          }),
        }
      },
    } as unknown as D1Database

    await createReservation(mockDB, 'TestUser', 'testuser', 'test@example.com', 'token123', 9999999999)

    const insertSql = sqlStatements[0]
    expect(insertSql).toContain("'public-reservation'")
    expect(insertSql).toContain('claim_source')
  })
})
