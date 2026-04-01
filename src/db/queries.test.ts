// ABOUTME: Tests for database query functions
// ABOUTME: Validates search functionality with fake D1 database

import { describe, it, expect } from 'vitest'
import { searchUsernames, claimUsername, createReservation, reserveUsername, type SearchParams } from './queries'
import { createFakeD1, type MockRecord } from './test-helpers'

const mockRecords: MockRecord[] = [
  {
    id: 1, name: 'alice', username_display: 'alice', username_canonical: 'alice',
    pubkey: 'abc123', email: 'alice@example.com', status: 'active',
    created_at: 1700000000, updated_at: 1700000000, claimed_at: 1700000000,
    reserved_reason: null, claim_source: 'unknown',
  },
  {
    id: 2, name: 'bob', username_display: 'bob', username_canonical: 'bob',
    pubkey: 'def456', email: 'bob@example.com', status: 'reserved',
    created_at: 1700000100, updated_at: 1700000100,
    reserved_reason: 'Test reservation', claim_source: 'unknown',
  },
  {
    id: 3, name: 'charlie', username_display: 'charlie', username_canonical: 'charlie',
    pubkey: 'ghi789', email: 'charlie@example.com', status: 'active',
    created_at: 1700000200, updated_at: 1700000200, claimed_at: 1700000200,
    reserved_reason: null, claim_source: 'unknown',
  },
  {
    id: 4, name: 'vineuser', username_display: 'vineuser', username_canonical: 'vineuser',
    pubkey: 'vine123', email: 'vine@example.com', status: 'active',
    created_at: 1700000300, updated_at: 1700000300, claimed_at: 1700000300,
    reserved_reason: 'Imported from Vine account', claim_source: 'vine-import',
  },
]

describe('searchUsernames', () => {
  it('should search by username', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: 'alice' })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
    expect(result.pagination.total).toBe(1)
  })

  it('should search by pubkey', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: 'abc123' })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].pubkey).toBe('abc123')
  })

  it('should search by email', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: 'bob@example.com' })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].email).toBe('bob@example.com')
  })

  it('should filter by status', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', status: 'active' })

    expect(result.results.every(u => u.status === 'active')).toBe(true)
  })

  it('should handle pagination with default values', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '' })

    expect(result.pagination.page).toBe(1)
    expect(result.pagination.limit).toBe(50)
  })

  it('should handle custom pagination', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', page: 2, limit: 1 })

    expect(result.pagination.page).toBe(2)
    expect(result.pagination.limit).toBe(1)
  })

  it('should calculate total pages correctly', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', limit: 2 })

    expect(result.pagination.total).toBe(4)
    expect(result.pagination.total_pages).toBe(2)
  })

  it('should not throw error with LIKE special characters in query', async () => {
    const db = createFakeD1(mockRecords)

    const result1 = await searchUsernames(db, { query: 'alice%' })
    expect(result1).toBeDefined()
    expect(result1.pagination).toBeDefined()

    const result2 = await searchUsernames(db, { query: 'bob_' })
    expect(result2).toBeDefined()
    expect(result2.pagination).toBeDefined()
  })

  it('should return empty results when no matches found', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: 'nonexistent' })

    expect(result.results).toHaveLength(0)
    expect(result.pagination.total).toBe(0)
    expect(result.pagination.total_pages).toBe(0)
  })

  it('should handle empty query string and return all results', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '' })

    expect(result.results.length).toBe(4)
    expect(result.pagination.total).toBe(4)
  })

  it('should handle empty query with status filter', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', status: 'active' })

    expect(result.results.every(u => u.status === 'active')).toBe(true)
    expect(result.results.length).toBe(3)
    expect(result.pagination.total).toBe(3)
  })

  it('should handle empty query with reserved status filter', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', status: 'reserved' })

    expect(result.results.every(u => u.status === 'reserved')).toBe(true)
    expect(result.results.length).toBe(1)
    expect(result.pagination.total).toBe(1)
  })

  it('should handle empty query with pagination', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', page: 1, limit: 2 })

    expect(result.results.length).toBe(2)
    expect(result.pagination.total).toBe(4)
    expect(result.pagination.total_pages).toBe(2)
    expect(result.pagination.page).toBe(1)
    expect(result.pagination.limit).toBe(2)
  })

  it('should handle empty query with pagination page 2', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', page: 2, limit: 2 })

    expect(result.results.length).toBe(2)
    expect(result.pagination.total).toBe(4)
    expect(result.pagination.total_pages).toBe(2)
    expect(result.pagination.page).toBe(2)
  })

  it('should combine query and status filters', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: 'alice', status: 'active' })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
    expect(result.results[0].status).toBe('active')
  })

  it('should return empty results when status filter excludes all matches', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: 'alice', status: 'reserved' })

    expect(result.results).toHaveLength(0)
  })

  it('should apply the recovered filter', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', status: 'recovered' })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('vineuser')
    expect(result.results[0].status).toBe('active')
    expect(result.pagination.total).toBe(1)
  })
})

describe('claimUsername', () => {
  it('should set claim_source to self-service', async () => {
    const sqlStatements: string[] = []
    const mockDB = {
      prepare: (sql: string) => {
        sqlStatements.push(sql)
        return {
          bind: (..._params: any[]) => ({
            run: async () => ({ success: true }),
          }),
        }
      },
    } as unknown as D1Database

    await claimUsername(mockDB, 'TestUser', 'testuser', 'abc123', null)

    const insertSql = sqlStatements[1]
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
          bind: (..._params: any[]) => ({
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
