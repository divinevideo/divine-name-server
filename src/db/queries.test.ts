// ABOUTME: Tests for database query functions
// ABOUTME: Validates search functionality with fake D1 database

import { describe, it, expect } from 'vitest'
import { searchUsernames, claimUsername, assignUsername, createReservation, reserveUsername, revokeUsername, addTag, removeTag, getTagsForUsername, getTagDetailsForUsername, getTagsForUsernames, getAllTags, getUsernameByName, getUsernameStats, updateAdminNotes, type SearchParams, type Username } from './queries'
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

  it('should clear revoked_at in ON CONFLICT clause', async () => {
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
    expect(insertSql).toContain('ON CONFLICT')
    expect(insertSql).toContain('revoked_at = NULL')
  })
})

describe('assignUsername', () => {
  it('should clear revoked_at in ON CONFLICT clause', async () => {
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

    await assignUsername(mockDB, 'TestUser', 'testuser', 'abc123', 'admin', 'matt@divine.video')

    const insertSql = sqlStatements[1]
    expect(insertSql).toContain('ON CONFLICT')
    expect(insertSql).toContain('revoked_at = NULL')
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

  it('should clear revoked_at in ON CONFLICT clause', async () => {
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

    await reserveUsername(mockDB, 'TestName', 'testname', 'brand protection', 'admin', 'matt@divine.video')

    expect(sqlStatements[0]).toContain('ON CONFLICT')
    expect(sqlStatements[0]).toContain('revoked_at = NULL')
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

  it('should clear revoked_at in ON CONFLICT clause', async () => {
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
    expect(insertSql).toContain('ON CONFLICT')
    expect(insertSql).toContain('revoked_at = NULL')
  })
})

// Stateful mock that faithfully tracks revoked_at through the revoke-then-upsert flow.
// Reproduces the ericartell bug: claimUsername on a name the same pubkey already owns
// should NOT leave revoked_at set.
function createStatefulMockDB(initialRecords: Partial<Username>[] = []) {
  const records: Partial<Username>[] = [...initialRecords]

  return {
    _records: records,
    prepare: (sql: string) => {
      let boundParams: any[] = []
      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async <T>(): Promise<T | null> => {
              if (sql.includes('username_canonical = ?') || sql.includes('name = ?')) {
                const lookupValues = boundParams.filter(p => typeof p === 'string')
                return (records.find(r =>
                  lookupValues.includes(r.username_canonical as string) ||
                  lookupValues.includes(r.name as string)
                ) as T) || null
              }
              if (sql.includes('pubkey = ?') && sql.includes('status = ?')) {
                const pubkey = boundParams[0]
                const status = boundParams[1]
                return (records.find(r => r.pubkey === pubkey && r.status === status) as T) || null
              }
              return null
            },
            all: async () => ({ results: records }),
            run: async () => {
              // UPDATE ... SET status = 'revoked', revoked_at = ? ... WHERE pubkey = ? AND status = 'active'
              if (sql.includes("SET status = 'revoked'") && sql.includes('WHERE pubkey = ?')) {
                const revokedAt = boundParams[0]
                const updatedAt = boundParams[1]
                const pubkey = boundParams[2]
                for (const r of records) {
                  if (r.pubkey === pubkey && r.status === 'active') {
                    r.status = 'revoked'
                    r.revoked_at = revokedAt
                    r.updated_at = updatedAt
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // UPDATE ... SET status = ?, recyclable = ?, revoked_at = ? ... WHERE username_canonical = ?
              if (sql.includes('SET status = ?') && sql.includes('recyclable = ?') && sql.includes('revoked_at = ?')) {
                const status = boundParams[0]
                const recyclable = boundParams[1]
                const revokedAt = boundParams[2]
                const updatedAt = boundParams[3]
                const canonical = boundParams[4]
                const name = boundParams[5]
                for (const r of records) {
                  if (r.username_canonical === canonical || r.name === name) {
                    r.status = status
                    r.recyclable = recyclable
                    r.revoked_at = revokedAt
                    r.updated_at = updatedAt
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // INSERT ... ON CONFLICT DO UPDATE (claimUsername / assignUsername / reserveUsername / createReservation)
              if (sql.includes('INSERT INTO usernames') && sql.includes('ON CONFLICT')) {
                const canonical = boundParams[2]
                const existing = records.find(r => r.username_canonical === canonical)

                if (existing) {
                  // ON CONFLICT path: apply the SET clauses
                  if (sql.includes("status = 'active'")) {
                    existing.status = 'active'
                    existing.pubkey = boundParams[3]
                    existing.claimed_at = boundParams[boundParams.length - 1]
                  } else if (sql.includes("status = 'reserved'")) {
                    existing.status = 'reserved'
                  } else if (sql.includes("status = 'pending-confirmation'")) {
                    existing.status = 'pending-confirmation' as any
                  }
                  existing.updated_at = boundParams[boundParams.length - 2] || Math.floor(Date.now() / 1000)
                  // The critical part: does the SQL clear revoked_at?
                  if (sql.includes('revoked_at = NULL')) {
                    existing.revoked_at = null
                  }
                  // If sql does NOT include 'revoked_at = NULL', revoked_at stays as-is (the bug)
                } else {
                  // Fresh INSERT
                  records.push({
                    id: records.length + 1,
                    name: boundParams[0],
                    username_display: boundParams[1],
                    username_canonical: boundParams[2],
                    pubkey: boundParams[3] || null,
                    status: 'active',
                    revoked_at: null,
                    created_at: Math.floor(Date.now() / 1000),
                    updated_at: Math.floor(Date.now() / 1000),
                    claimed_at: Math.floor(Date.now() / 1000),
                  })
                }
                return { success: true, meta: { changes: 1 } }
              }

              return { success: true, meta: { changes: 0 } }
            },
          }
        },
      }
    },
  } as unknown as D1Database & { _records: Partial<Username>[] }
}

describe('revoked_at clearing (ericartell bug)', () => {
  it('claimUsername: re-claiming same name should clear revoked_at', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'ericartell', username_display: 'EricArtell', username_canonical: 'ericartell',
      pubkey: 'aaa111', status: 'active', revoked_at: null,
      created_at: 1700000000, updated_at: 1700000000, claimed_at: 1700000000,
    }])

    // Same pubkey re-claims the same name (e.g., updating relays)
    await claimUsername(db, 'EricArtell', 'ericartell', 'aaa111', ['wss://relay.divine.video'])

    const record = db._records.find(r => r.username_canonical === 'ericartell')!
    expect(record.status).toBe('active')
    expect(record.revoked_at).toBeNull()
  })

  it('claimUsername: claiming a previously-revoked name should clear revoked_at', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'oldname', username_display: 'oldname', username_canonical: 'oldname',
      pubkey: 'bbb222', status: 'revoked', revoked_at: 1700000000,
      created_at: 1699000000, updated_at: 1700000000,
    }])

    // New user claims the revoked name
    await claimUsername(db, 'oldname', 'oldname', 'ccc333', null)

    const record = db._records.find(r => r.username_canonical === 'oldname')!
    expect(record.status).toBe('active')
    expect(record.pubkey).toBe('ccc333')
    expect(record.revoked_at).toBeNull()
  })

  it('claimUsername: claiming a reserved Vine import name should clear revoked_at', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'vinestar', username_display: 'VineStar', username_canonical: 'vinestar',
      pubkey: null, status: 'revoked', revoked_at: 1690000000,
      reserved_reason: 'Imported from Vine account', claim_source: 'vine-import',
      created_at: 1680000000, updated_at: 1690000000,
    }])

    await claimUsername(db, 'VineStar', 'vinestar', 'newowner999', ['wss://relay.divine.video'])

    const record = db._records.find(r => r.username_canonical === 'vinestar')!
    expect(record.status).toBe('active')
    expect(record.pubkey).toBe('newowner999')
    expect(record.revoked_at).toBeNull()
  })

  it('claimUsername: switching names should revoke old and activate new cleanly', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'firstname', username_display: 'FirstName', username_canonical: 'firstname',
      pubkey: 'user123', status: 'active', revoked_at: null,
      created_at: 1700000000, updated_at: 1700000000, claimed_at: 1700000000,
    }])

    // User claims a different name -- old one gets revoked, new one is fresh INSERT
    await claimUsername(db, 'SecondName', 'secondname', 'user123', null)

    const oldRecord = db._records.find(r => r.username_canonical === 'firstname')!
    expect(oldRecord.status).toBe('revoked')
    expect(oldRecord.revoked_at).not.toBeNull()

    const newRecord = db._records.find(r => r.username_canonical === 'secondname')!
    expect(newRecord.status).toBe('active')
    expect(newRecord.revoked_at).toBeNull()
  })

  it('assignUsername: assigning over a revoked record should clear revoked_at', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'adminassign', username_display: 'AdminAssign', username_canonical: 'adminassign',
      pubkey: null, status: 'revoked', revoked_at: 1700000000,
      created_at: 1699000000, updated_at: 1700000000,
    }])

    await assignUsername(db, 'AdminAssign', 'adminassign', 'assigned123', 'admin', 'matt@divine.video')

    const record = db._records.find(r => r.username_canonical === 'adminassign')!
    expect(record.status).toBe('active')
    expect(record.pubkey).toBe('assigned123')
    expect(record.revoked_at).toBeNull()
  })

  it('reserveUsername: re-reserving a revoked name should clear revoked_at', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'brandname', username_display: 'BrandName', username_canonical: 'brandname',
      pubkey: 'old999', status: 'revoked', revoked_at: 1700000000,
      created_at: 1699000000, updated_at: 1700000000,
    }])

    await reserveUsername(db, 'BrandName', 'brandname', 'brand protection', 'admin', 'matt@divine.video')

    const record = db._records.find(r => r.username_canonical === 'brandname')!
    expect(record.status).toBe('reserved')
    expect(record.revoked_at).toBeNull()
  })

  it('createReservation: reserving over a revoked name should clear revoked_at', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'expiredres', username_display: 'ExpiredRes', username_canonical: 'expiredres',
      pubkey: null, status: 'revoked', revoked_at: 1700000000,
      created_at: 1699000000, updated_at: 1700000000,
    }])

    await createReservation(db, 'ExpiredRes', 'expiredres', 'user@example.com', 'token123', 9999999999)

    const record = db._records.find(r => r.username_canonical === 'expiredres')!
    expect(record.status).toBe('pending-confirmation')
    expect(record.revoked_at).toBeNull()
  })

  it('revokeUsername: should set revoked_at when revoking', async () => {
    const db = createStatefulMockDB([{
      id: 1, name: 'tobanned', username_display: 'ToBanned', username_canonical: 'tobanned',
      pubkey: 'user999', status: 'active', revoked_at: null,
      created_at: 1700000000, updated_at: 1700000000,
    }])

    await revokeUsername(db, 'tobanned', false)

    const record = db._records.find(r => r.username_canonical === 'tobanned')!
    expect(record.status).toBe('revoked')
    expect(record.revoked_at).not.toBeNull()
    expect(typeof record.revoked_at).toBe('number')
  })
})

describe('username tags', () => {
  it('adds a tag to a username', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual(['vip'])
  })

  it('normalizes tags to lowercase', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, '  VIP  ', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual(['vip'])
  })

  it('prevents duplicate tags', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual(['vip'])
  })

  it('supports multiple tags per username', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vine-legacy', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toContain('vip')
    expect(tags).toContain('vine-legacy')
  })

  it('removes a tag', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await removeTag(db, 1, 'vip')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual([])
  })

  it('returns all distinct tags with counts', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
      { name: 'lelepons', username_canonical: 'lelepons', status: 'reserved', id: 2 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 2, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vine-legacy', 'matthew@divine.video')
    const allTags = await getAllTags(db)
    expect(allTags).toContainEqual({ tag: 'vip', count: 2 })
    expect(allTags).toContainEqual({ tag: 'vine-legacy', count: 1 })
  })

  it('rejects empty tags', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await expect(addTag(db, 1, '', 'matthew@divine.video')).rejects.toThrow()
    await expect(addTag(db, 1, '   ', 'matthew@divine.video')).rejects.toThrow()
  })

  it('returns tag details with created_by and created_at', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vine-legacy', 'liz@divine.video')
    const details = await getTagDetailsForUsername(db, 1)
    expect(details).toHaveLength(2)
    const vip = details.find(d => d.tag === 'vip')
    expect(vip).toBeDefined()
    expect(vip!.created_by).toBe('matthew@divine.video')
    expect(typeof vip!.created_at).toBe('number')
    const legacy = details.find(d => d.tag === 'vine-legacy')
    expect(legacy).toBeDefined()
    expect(legacy!.created_by).toBe('liz@divine.video')
  })

  it('batch loads tags for multiple usernames', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
      { name: 'lelepons', username_canonical: 'lelepons', status: 'reserved', id: 2 },
      { name: 'notaguser', username_canonical: 'notaguser', status: 'active', id: 3 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 2, 'vine-legacy', 'matthew@divine.video')
    const tagMap = await getTagsForUsernames(db, [1, 2, 3])
    expect(tagMap.get(1)).toEqual(['vip'])
    expect(tagMap.get(2)).toEqual(['vine-legacy'])
    expect(tagMap.has(3)).toBe(false)
  })
})

describe('search sort', () => {
  it('should support oldest-first sorting', async () => {
    const db = createFakeD1(mockRecords)
    const result = await searchUsernames(db, { query: '', sort: 'oldest' })
    expect(result.results[0].name).toBe('alice')
    expect(result.results[result.results.length - 1].name).toBe('vineuser')
  })

  it('should support updated sorting', async () => {
    const recs: MockRecord[] = [
      { id: 1, name: 'old', username_canonical: 'old', status: 'active', created_at: 1000, updated_at: 9000 },
      { id: 2, name: 'new', username_canonical: 'new', status: 'active', created_at: 9000, updated_at: 1000 },
    ]
    const db = createFakeD1(recs)
    const result = await searchUsernames(db, { query: '', sort: 'updated' })
    expect(result.results[0].name).toBe('old')
  })
})

describe('search across notes and tags', () => {
  it('should find usernames by admin_notes content', async () => {
    const recs: MockRecord[] = [
      { id: 1, name: 'alice', username_canonical: 'alice', status: 'active', admin_notes: 'VIP creator account', created_at: 1000, updated_at: 1000 },
      { id: 2, name: 'bob', username_canonical: 'bob', status: 'active', created_at: 2000, updated_at: 2000 },
    ]
    const db = createFakeD1(recs)
    const result = await searchUsernames(db, { query: 'VIP' })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
  })

  it('should find usernames by tag content', async () => {
    const recs: MockRecord[] = [
      { id: 1, name: 'alice', username_canonical: 'alice', status: 'active', created_at: 1000, updated_at: 1000 },
      { id: 2, name: 'bob', username_canonical: 'bob', status: 'active', created_at: 2000, updated_at: 2000 },
    ]
    const db = createFakeD1(recs)
    await addTag(db, 1, 'creator', 'admin')
    const result = await searchUsernames(db, { query: 'creator' })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('alice')
  })
})

describe('getUsernameStats', () => {
  it('should return totals and metadata counts', async () => {
    const recs: MockRecord[] = [
      { id: 1, name: 'a', username_canonical: 'a', status: 'active', admin_notes: 'some note', created_at: 1000, updated_at: 1000 },
      { id: 2, name: 'b', username_canonical: 'b', status: 'reserved', created_at: 2000, updated_at: 2000 },
      { id: 3, name: 'c', username_canonical: 'c', status: 'pending-confirmation', created_at: 3000, updated_at: 3000 },
    ]
    const db = createFakeD1(recs)
    await addTag(db, 1, 'vip', 'admin')
    const stats = await getUsernameStats(db)
    expect(stats.totals.all).toBe(3)
    expect(stats.totals.active).toBe(1)
    expect(stats.totals.reserved).toBe(1)
    expect(stats.totals.pending_confirmation).toBe(1)
    expect(stats.metadata.with_notes).toBe(1)
    expect(stats.metadata.with_tags).toBe(1)
    expect(stats.metadata.untagged).toBe(2)
    expect(stats.metadata.vip).toBe(1)
    expect(stats.top_tags).toContainEqual({ tag: 'vip', count: 1 })
  })
})

describe('updateAdminNotes', () => {
  it('should update admin_notes for an existing username', async () => {
    const recs: MockRecord[] = [
      { id: 1, name: 'alice', username_canonical: 'alice', status: 'active', created_at: 1000, updated_at: 1000 },
    ]
    const db = createFakeD1(recs)
    const result = await updateAdminNotes(db, 'alice', 'Important creator', 'admin@divine.video')
    expect(result?.admin_notes).toBe('Important creator')
    expect(result?.admin_notes_updated_by).toBe('admin@divine.video')
    expect(result?.admin_notes_updated_at).toBeTypeOf('number')

    const updated = await getUsernameByName(db, 'alice')
    expect(updated?.admin_notes).toBe('Important creator')
    expect(updated?.admin_notes_updated_by).toBe('admin@divine.video')
    expect(updated?.admin_notes_updated_at).toBeTypeOf('number')
  })

  it('should return null for non-existent username', async () => {
    const db = createFakeD1([])
    const result = await updateAdminNotes(db, 'nobody', 'test', 'admin@divine.video')
    expect(result).toBe(null)
  })
})
