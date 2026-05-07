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

      // Filter records by search term (matches name, display, canonical, pubkey, email, admin_notes, tags)
      function applySearch(data: MockRecord[]): MockRecord[] {
        const term = extractSearchTerm()
        if (!term || term.length === 0) return data
        return data.filter(
          (u) => {
            const userTags = tags.filter(t => t.username_id === u.id).map(t => t.tag)
            return (
              u.name?.includes(term) ||
              u.username_display?.includes(term) ||
              u.username_canonical?.includes(term) ||
              u.pubkey?.includes(term) ||
              u.email?.includes(term) ||
              u.admin_notes?.includes(term) ||
              userTags.some(t => t.includes(term))
            )
          }
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
              // Stats COUNT queries on username_tags (not search queries with EXISTS subqueries)
              if (sql.includes('COUNT(DISTINCT username_id)') && sql.includes('FROM username_tags')) {
                if (sql.includes('tag = ?')) {
                  const tagVal = boundParams[0]
                  return { count: new Set(tags.filter(t => t.tag === tagVal).map(t => t.username_id)).size }
                }
                return { count: new Set(tags.map(t => t.username_id)).size }
              }

              // Consolidated stats summary query
              if (sql.includes('all_count') && sql.includes('pending_confirmation_count')) {
                const [sevenDaysAgo, thirtyDaysAgo, updatedSevenDaysAgo, updatedThirtyDaysAgo] = boundParams
                const taggedIds = new Set(tags.map(t => t.username_id))
                const vipIds = new Set(tags.filter(t => t.tag === 'vip').map(t => t.username_id))
                return {
                  all_count: records.length,
                  active_count: records.filter(u => u.status === 'active').length,
                  reserved_count: records.filter(u => u.status === 'reserved').length,
                  revoked_count: records.filter(u => u.status === 'revoked').length,
                  burned_count: records.filter(u => u.status === 'burned').length,
                  pending_confirmation_count: records.filter(u => u.status === 'pending-confirmation').length,
                  with_notes_count: records.filter(u => typeof u.admin_notes === 'string' && u.admin_notes.trim().length > 0).length,
                  with_tags_count: records.filter(u => u.id != null && taggedIds.has(u.id)).length,
                  untagged_count: records.filter(u => u.id == null || !taggedIds.has(u.id)).length,
                  vip_count: records.filter(u => u.id != null && vipIds.has(u.id)).length,
                  claimed_7d_count: records.filter(u => typeof u.claimed_at === 'number' && u.claimed_at >= sevenDaysAgo).length,
                  claimed_30d_count: records.filter(u => typeof u.claimed_at === 'number' && u.claimed_at >= thirtyDaysAgo).length,
                  updated_7d_count: records.filter(u => (u.updated_at || 0) >= updatedSevenDaysAgo).length,
                  updated_30d_count: records.filter(u => (u.updated_at || 0) >= updatedThirtyDaysAgo).length,
                }
              }

              // COUNT query
              if (sql.includes('COUNT(*)')) {
                // Search COUNT (has LIKE patterns) — handle first to avoid matching stats patterns
                if (sql.includes('LIKE')) {
                  let filtered = [...records]
                  filtered = applySearch(filtered)
                  if (sql.includes("status = 'active'") && sql.includes('reserved_reason')) {
                    filtered = applyRecoveredFilter(filtered)
                  } else {
                    filtered = applyStatusFilter(filtered)
                  }
                  return { count: filtered.length }
                }
                // Stats: admin_notes presence
                if (sql.includes('admin_notes IS NOT NULL')) {
                  return { count: records.filter(u => typeof u.admin_notes === 'string' && u.admin_notes.trim().length > 0).length }
                }
                // Stats: untagged
                if (sql.includes('NOT EXISTS') && sql.includes('username_tags')) {
                  return { count: records.filter(u => !tags.some(t => t.username_id === u.id)).length }
                }
                // Stats: claimed_at window
                if (sql.includes('claimed_at IS NOT NULL') && sql.includes('claimed_at >= ?')) {
                  const since = boundParams[0]
                  return { count: records.filter(u => typeof u.claimed_at === 'number' && u.claimed_at >= since).length }
                }
                // Stats: updated_at window
                if (sql.includes('updated_at >= ?')) {
                  const since = boundParams[0]
                  return { count: records.filter(u => (u.updated_at || 0) >= since).length }
                }

                // Non-search COUNT (status filter only, no LIKE)
                let filtered = [...records]
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
              // Tag queries (but not search queries that reference tags in EXISTS subqueries)
              if (sql.includes('username_tags') && !sql.includes('FROM usernames')) {
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
                  const entries = Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }))
                  // Respect ORDER BY count DESC if present
                  if (sql.includes('count DESC')) {
                    entries.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
                  } else {
                    entries.sort((a, b) => a.tag.localeCompare(b.tag))
                  }
                  return { results: entries }
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

              // Tag filter via exact-match EXISTS subquery in WHERE clause (AND ut.tag = ?)
              // The ORDER BY CASE also uses ut.tag = ? for relevance ranking — distinguish
              // by checking for the pattern in the WHERE clause (before ORDER BY)
              const whereClause = sql.split('ORDER BY')[0]
              if (whereClause.includes('ut.tag = ?')) {
                // The exact tag param is the last non-% string before limit/offset
                const tagParam = boundParams.find(p => typeof p === 'string' && !p.includes('%') && !['active', 'reserved', 'revoked', 'burned', 'pending-confirmation'].includes(p))
                if (tagParam) {
                  const taggedIds = new Set(tags.filter(t => t.tag === tagParam).map(t => t.username_id))
                  filtered = filtered.filter(u => u.id != null && taggedIds.has(u.id))
                }
              }

              const { limit, offset } = extractPagination()

              // Respect sort order from SQL
              if (sql.includes('created_at ASC')) {
                filtered.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
              } else if (sql.includes('updated_at DESC')) {
                filtered.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
              } else {
                filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
              }

              return {
                results: filtered.slice(offset, offset + limit),
              }
            },

            run: async () => {
              // Admin notes UPDATE
              if (sql.includes('UPDATE usernames') && sql.includes('admin_notes = ?')) {
                const [adminNotes, updatedBy, updatedAtNotes, updatedAt, id] = boundParams
                const rec = records.find(r => r.id === id)
                if (rec) {
                  rec.admin_notes = adminNotes
                  rec.admin_notes_updated_by = updatedBy
                  rec.admin_notes_updated_at = updatedAtNotes
                  rec.updated_at = updatedAt
                }
                return { success: true, meta: { changes: rec ? 1 : 0 } }
              }
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
