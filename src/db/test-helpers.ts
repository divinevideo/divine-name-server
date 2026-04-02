// ABOUTME: Shared D1 fake for tests. Operates on in-memory data with
// ABOUTME: lighter SQL-shape coupling and no bound-parameter position indexing.

import type { Username } from './queries'

export type MockRecord = Partial<Username> & { name: string; username_canonical: string }

/**
 * Create a fake D1 database backed by in-memory records.
 *
 * Instead of relying on brittle positional indexing into bound params, this
 * fake uses a few coarse SQL markers to determine the operation and then
 * filters against in-memory data. Tests pass real query functions
 * (searchUsernames, getUsernameByName, etc.) through this fake, validating
 * behavior with less coupling to query text and parameter ordering than the
 * old duplicated mocks.
 */
export function createFakeD1(records: MockRecord[]) {
  const tags: { username_id: number; tag: string; created_at: number; created_by: string }[] = []

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
              // Tag queries
              if (sql.includes('username_tags')) {
                // SELECT tag FROM username_tags WHERE username_id = ?
                if (sql.includes('WHERE username_id = ?') && !sql.includes('IN (')) {
                  const uid = boundParams[0]
                  return { results: tags.filter(t => t.username_id === uid).sort((a, b) => a.tag.localeCompare(b.tag)) }
                }
                // SELECT username_id, tag FROM username_tags WHERE username_id IN (...)
                if (sql.includes('IN (')) {
                  const ids = boundParams.filter(p => typeof p === 'number')
                  return { results: tags.filter(t => ids.includes(t.username_id)).sort((a, b) => a.tag.localeCompare(b.tag)) }
                }
                // SELECT tag, COUNT(*) as count FROM username_tags GROUP BY tag
                if (sql.includes('COUNT(*)') || sql.includes('GROUP BY')) {
                  const counts = new Map<string, number>()
                  for (const t of tags) {
                    counts.set(t.tag, (counts.get(t.tag) || 0) + 1)
                  }
                  return { results: Array.from(counts.entries()).map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag)) }
                }
                return { results: [] }
              }

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

              // Tag filter via EXISTS subquery
              if (sql.includes('username_tags') && sql.includes('EXISTS')) {
                const tagParam = boundParams.find(p => typeof p === 'string' && !p.includes('%'))
                if (tagParam) {
                  const taggedIds = new Set(tags.filter(t => t.tag === tagParam).map(t => t.username_id))
                  filtered = filtered.filter(u => u.id != null && taggedIds.has(u.id))
                }
              }

              const { limit, offset } = extractPagination()

              return {
                results: filtered
                  .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
                  .slice(offset, offset + limit),
              }
            },

            run: async () => {
              // Tag INSERT
              if (sql.includes('INSERT') && sql.includes('username_tags')) {
                const [username_id, tag, created_at, created_by] = boundParams
                if (!tags.some(t => t.username_id === username_id && t.tag === tag)) {
                  tags.push({ username_id, tag, created_at, created_by })
                }
                return { success: true, meta: { changes: 1 } }
              }
              // Tag DELETE
              if (sql.includes('DELETE') && sql.includes('username_tags')) {
                const [username_id, tag] = boundParams
                const idx = tags.findIndex(t => t.username_id === username_id && t.tag === tag)
                if (idx >= 0) tags.splice(idx, 1)
                return { success: true, meta: { changes: idx >= 0 ? 1 : 0 } }
              }
              return { success: true, meta: { changes: 1 } }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}
