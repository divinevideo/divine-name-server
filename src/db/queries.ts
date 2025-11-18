// ABOUTME: Database query helpers for usernames and reserved words
// ABOUTME: Provides type-safe D1 database operations

export interface Username {
  id: number
  name: string
  pubkey: string | null
  email: string | null
  relays: string | null
  status: 'active' | 'reserved' | 'revoked' | 'burned'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
}

export interface SearchParams {
  query: string
  status?: 'active' | 'reserved' | 'revoked' | 'burned'
  page?: number
  limit?: number
}

export interface SearchResult {
  results: Username[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
}

export async function isReservedWord(
  db: D1Database,
  word: string
): Promise<boolean> {
  const result = await db.prepare(
    'SELECT 1 FROM reserved_words WHERE word = ?'
  ).bind(word).first()

  return result !== null
}

export async function getUsernameByName(
  db: D1Database,
  name: string
): Promise<Username | null> {
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE name = ?'
  ).bind(name).first<Username>()

  return result
}

export async function getUsernameByPubkey(
  db: D1Database,
  pubkey: string
): Promise<Username | null> {
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE pubkey = ? AND status = ?'
  ).bind(pubkey, 'active').first<Username>()

  return result
}

export async function claimUsername(
  db: D1Database,
  name: string,
  pubkey: string,
  relays: string[] | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const relaysJson = relays ? JSON.stringify(relays) : null

  // First, revoke any existing active username for this pubkey
  await db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE pubkey = ? AND status = 'active'`
  ).bind(now, now, pubkey).run()

  // Then insert or update the new username
  await db.prepare(
    `INSERT INTO usernames (name, pubkey, relays, status, created_at, updated_at, claimed_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       pubkey = excluded.pubkey,
       relays = excluded.relays,
       status = 'active',
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(name, pubkey, relaysJson, now, now, now).run()
}

export async function getAllActiveUsernames(
  db: D1Database
): Promise<Username[]> {
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE status = ?'
  ).bind('active').all<Username>()

  return result.results
}

export async function reserveUsername(
  db: D1Database,
  name: string,
  reason: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await db.prepare(
    `INSERT INTO usernames (name, status, reserved_reason, created_at, updated_at)
     VALUES (?, 'reserved', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       status = 'reserved',
       reserved_reason = excluded.reserved_reason,
       updated_at = excluded.updated_at`
  ).bind(name, reason, now, now).run()
}

export async function revokeUsername(
  db: D1Database,
  name: string,
  burn: boolean
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const status = burn ? 'burned' : 'revoked'
  const recyclable = burn ? 0 : 1

  await db.prepare(
    `UPDATE usernames
     SET status = ?,
         recyclable = ?,
         revoked_at = ?,
         updated_at = ?
     WHERE name = ?`
  ).bind(status, recyclable, now, now, name).run()
}

export async function assignUsername(
  db: D1Database,
  name: string,
  pubkey: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  // Revoke existing username for this pubkey
  await db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE pubkey = ? AND status = 'active'`
  ).bind(now, now, pubkey).run()

  // Assign username
  await db.prepare(
    `INSERT INTO usernames (name, pubkey, status, created_at, updated_at, claimed_at)
     VALUES (?, ?, 'active', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       pubkey = excluded.pubkey,
       status = 'active',
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(name, pubkey, now, now, now).run()
}

function escapeLikePattern(str: string): string {
  // Escape special LIKE characters (% and _) to prevent injection
  return str.replace(/[%_]/g, '\\$&')
}

export async function searchUsernames(
  db: D1Database,
  params: SearchParams
): Promise<SearchResult> {
  const { query, status, page = 1, limit = 50 } = params
  const offset = (page - 1) * limit
  const escapedQuery = escapeLikePattern(query)
  const searchPattern = `%${escapedQuery}%`

  // Build WHERE clause
  let whereClause = `(name LIKE ? OR pubkey LIKE ? OR email LIKE ?)`
  const queryParams: any[] = [searchPattern, searchPattern, searchPattern]

  if (status) {
    whereClause += ` AND status = ?`
    queryParams.push(status)
  }

  // Get total count
  const countResult = await db.prepare(
    `SELECT COUNT(*) as count FROM usernames WHERE ${whereClause}`
  ).bind(...queryParams).first<{ count: number }>()

  const total = countResult?.count || 0
  const totalPages = Math.ceil(total / limit)

  // Get paginated results
  const results = await db.prepare(
    `SELECT * FROM usernames
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...queryParams, limit, offset).all<Username>()

  return {
    results: results.results,
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages
    }
  }
}
