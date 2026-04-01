// ABOUTME: Shared D1 fake for tests. Operates on in-memory data without
// ABOUTME: coupling to SQL string shape or bound-parameter positions.

import type { Username } from './queries'

export type MockRecord = Partial<Username> & { name: string; username_canonical: string }

/**
 * Create a fake D1 database backed by in-memory records.
 *
 * Instead of sniffing SQL strings and indexing into bound params, this fake
 * determines the operation from high-level SQL markers and applies filters
 * using the actual data. Tests pass real query functions (searchUsernames,
 * getUsernameByName, etc.) through this fake, validating behavior without
 * coupling to query text or parameter ordering.
 */
export function createFakeD1(records: MockRecord[]) {
  return {
    prepare: (sql: string) => {
      let boundParams: any[] = []

      // Extract search term from LIKE-pattern bound params (%term%)
      function extractSearchTerm(): string | null {
        const pattern = boundParams.find(
          (p) => typeof p === 'string' && p.startsWith('%') && p.endsWith('%')
        )
        if (!pattern) return null
        return pattern.slice(1, -1).replace(/\\/g, '')
      }

      // Extract status from bound params. A LIKE pattern like "%active%" would also
      // contain "active", but applyStatusFilter gates on sql.includes('status = ?')
      // which is only present when a status filter was actually requested.
      function extractStatus(): string | null {
        const statuses = ['active', 'reserved', 'revoked', 'burned', 'pending-confirmation']
        return boundParams.find((p) => typeof p === 'string' && statuses.includes(p)) || null
      }

      // Filter records by search term (matches name, display, canonical, pubkey, email)
      function applySearch(data: MockRecord[]): MockRecord[] {
        const term = extractSearchTerm()
        if (!term || term.length === 0) return data
        return data.filter(
          (u) =>
            u.name?.includes(term) ||
            u.username_display?.includes(term) ||
            u.username_canonical?.includes(term) ||
            u.pubkey?.includes(term) ||
            u.email?.includes(term)
        )
      }

      // Filter records by status
      function applyStatusFilter(data: MockRecord[]): MockRecord[] {
        if (!sql.includes('status = ?')) return data
        const status = extractStatus()
        if (!status) return data
        return data.filter((u) => u.status === status)
      }

      // Apply recovered filter (special case — not a simple status match)
      function applyRecoveredFilter(data: MockRecord[]): MockRecord[] {
        if (!sql.includes("status = 'active'") || !sql.includes('reserved_reason LIKE')) return data
        return data.filter(
          (u) =>
            u.status === 'active' &&
            u.pubkey != null &&
            u.reserved_reason?.includes('Vine')
        )
      }

      // Extract limit and offset (always the last two numeric params)
      function extractPagination(): { limit: number; offset: number } {
        const nums = boundParams.filter((p) => typeof p === 'number')
        if (nums.length >= 2) {
          return { limit: nums[nums.length - 2], offset: nums[nums.length - 1] }
        }
        return { limit: 50, offset: 0 }
      }

      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
              // COUNT query
              if (sql.includes('COUNT(*)')) {
                let filtered = [...records]
                if (sql.includes('LIKE')) filtered = applySearch(filtered)
                if (sql.includes("status = 'active'") && sql.includes('reserved_reason')) {
                  filtered = applyRecoveredFilter(filtered)
                } else {
                  filtered = applyStatusFilter(filtered)
                }
                return { count: filtered.length }
              }

              // Direct username lookup
              if (sql.includes('username_canonical = ?') || sql.includes('name = ?')) {
                const lookupValues = boundParams.filter((p) => typeof p === 'string')
                return (
                  records.find(
                    (u) =>
                      lookupValues.includes(u.username_canonical) ||
                      lookupValues.includes(u.name)
                  ) || null
                )
              }

              // Reserved words check
              if (sql.includes('reserved_words') && sql.includes('SELECT 1')) {
                return null
              }

              return null
            },

            all: async () => {
              // Reserved words list
              if (sql.includes('reserved_words')) {
                return { results: [] }
              }

              // Search query
              let filtered = [...records]
              if (sql.includes('LIKE')) filtered = applySearch(filtered)
              if (sql.includes("status = 'active'") && sql.includes('reserved_reason')) {
                filtered = applyRecoveredFilter(filtered)
              } else {
                filtered = applyStatusFilter(filtered)
              }

              const { limit, offset } = extractPagination()

              return {
                results: filtered
                  .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
                  .slice(offset, offset + limit),
              }
            },

            run: async () => ({ success: true, meta: { changes: 1 } }),
          }
        },
      }
    },
  } as unknown as D1Database
}
