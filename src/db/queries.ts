// ABOUTME: Database query helpers for usernames and reserved words
// ABOUTME: Provides type-safe D1 database operations

export interface Username {
  id: number
  name: string // Legacy field, kept for backward compatibility
  username_display: string | null
  username_canonical: string | null
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
  // Normalize to lowercase for canonical lookup
  const canonical = name.toLowerCase()
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE username_canonical = ? OR name = ?'
  ).bind(canonical, name).first<Username>()

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
  nameDisplay: string,
  nameCanonical: string,
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

  // Then insert or update the new username using canonical for uniqueness
  await db.prepare(
    `INSERT INTO usernames (name, username_display, username_canonical, pubkey, relays, status, created_at, updated_at, claimed_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       name = excluded.name,
       username_display = excluded.username_display,
       pubkey = excluded.pubkey,
       relays = excluded.relays,
       status = 'active',
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(nameCanonical, nameDisplay, nameCanonical, pubkey, relaysJson, now, now, now).run()
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
  nameDisplay: string,
  nameCanonical: string,
  reason: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await db.prepare(
    `INSERT INTO usernames (name, username_display, username_canonical, status, reserved_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'reserved', ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       name = excluded.name,
       username_display = excluded.username_display,
       status = 'reserved',
       reserved_reason = excluded.reserved_reason,
       updated_at = excluded.updated_at`
  ).bind(nameCanonical, nameDisplay, nameCanonical, reason, now, now).run()
}

export async function revokeUsername(
  db: D1Database,
  name: string,
  burn: boolean
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const status = burn ? 'burned' : 'revoked'
  const recyclable = burn ? 0 : 1
  const canonical = name.toLowerCase()

  await db.prepare(
    `UPDATE usernames
     SET status = ?,
         recyclable = ?,
         revoked_at = ?,
         updated_at = ?
     WHERE username_canonical = ? OR name = ?`
  ).bind(status, recyclable, now, now, canonical, name).run()
}

export async function assignUsername(
  db: D1Database,
  nameDisplay: string,
  nameCanonical: string,
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

  // Assign username using canonical for uniqueness
  await db.prepare(
    `INSERT INTO usernames (name, username_display, username_canonical, pubkey, status, created_at, updated_at, claimed_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       name = excluded.name,
       username_display = excluded.username_display,
       pubkey = excluded.pubkey,
       status = 'active',
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(nameCanonical, nameDisplay, nameCanonical, pubkey, now, now, now).run()
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

  // Build WHERE clause
  let whereClause = ''
  const queryParams: any[] = []

  // If query is empty, don't filter by name/pubkey/email
  if (query && query.length > 0) {
    const escapedQuery = escapeLikePattern(query)
    const searchPattern = `%${escapedQuery}%`
    whereClause = `(name LIKE ? OR username_display LIKE ? OR username_canonical LIKE ? OR pubkey LIKE ? OR email LIKE ?)`
    queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern)
  }

  // Add status filter if provided
  if (status) {
    if (whereClause) {
      whereClause += ` AND status = ?`
    } else {
      whereClause = `status = ?`
    }
    queryParams.push(status)
  }

  // If no filters, use WHERE 1=1 to get all results
  if (!whereClause) {
    whereClause = '1=1'
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

export interface ReservedWord {
  word: string
  category: string
  reason: string | null
  created_at: number
}

export async function getReservedWords(
  db: D1Database
): Promise<ReservedWord[]> {
  const result = await db.prepare(
    'SELECT * FROM reserved_words ORDER BY category, word'
  ).all<ReservedWord>()

  return result.results
}

export async function addReservedWord(
  db: D1Database,
  word: string,
  category: string,
  reason: string | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await db.prepare(
    `INSERT INTO reserved_words (word, category, reason, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(word) DO UPDATE SET
       category = excluded.category,
       reason = excluded.reason`
  ).bind(word.toLowerCase(), category, reason, now).run()
}

export async function deleteReservedWord(
  db: D1Database,
  word: string
): Promise<void> {
  await db.prepare(
    'DELETE FROM reserved_words WHERE word = ?'
  ).bind(word.toLowerCase()).run()
}

export async function exportUsernamesByStatus(
  db: D1Database,
  status?: 'active' | 'reserved' | 'revoked' | 'burned'
): Promise<Username[]> {
  if (status) {
    const result = await db.prepare(
      'SELECT * FROM usernames WHERE status = ? ORDER BY name'
    ).bind(status).all<Username>()
    return result.results
  }

  const result = await db.prepare(
    'SELECT * FROM usernames ORDER BY status, name'
  ).all<Username>()
  return result.results
}
