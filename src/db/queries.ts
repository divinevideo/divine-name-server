// ABOUTME: Database query helpers for usernames and reserved words
// ABOUTME: Provides type-safe D1 database operations

export type ClaimSource = 'self-service' | 'admin' | 'bulk-upload' | 'vine-import' | 'public-reservation' | 'unknown'
export type SearchSort = 'relevance' | 'newest' | 'oldest' | 'updated'

export interface Username {
  id: number
  name: string // Legacy field, kept for backward compatibility
  username_display: string | null
  username_canonical: string | null
  pubkey: string | null
  email: string | null
  relays: string | null
  status: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
  reservation_email: string | null
  confirmation_token: string | null
  reservation_expires_at: number | null
  subscription_expires_at: number | null
  claim_source: ClaimSource
  created_by: string | null
  atproto_did: string | null
  atproto_state: 'pending' | 'ready' | 'failed' | 'disabled' | null
  tags?: string[]
}

export interface UsernameWithTags extends Username {
  tags: string[]
}

export interface ReservationToken {
  id: number
  token: string
  username_canonical: string
  email: string
  created_at: number
  confirmed_at: number | null
  expires_at: number
}

export interface SearchParams {
  query: string
  status?: 'active' | 'reserved' | 'revoked' | 'burned' | 'recovered'
  sort?: SearchSort
  page?: number
  limit?: number
}

export interface SearchResult {
  results: UsernameWithTags[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
}

export interface UsernameStats {
  totals: {
    all: number
    active: number
    reserved: number
    revoked: number
    burned: number
  }
  metadata: {
    with_notes: number
    with_tags: number
    untagged: number
    vip: number
  }
  activity: {
    claimed_7d: number
    claimed_30d: number
    updated_7d: number
    updated_30d: number
  }
  top_tags: Array<{ tag: string; count: number }>
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

function normalizeTag(tag: string): { display: string; normalized: string } | null {
  const display = tag.trim().replace(/\s+/g, ' ')
  if (!display) {
    return null
  }

  return {
    display,
    normalized: display.toLowerCase()
  }
}

function normalizeTags(tags: string[]): Array<{ display: string; normalized: string }> {
  const deduped = new Map<string, { display: string; normalized: string }>()

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      continue
    }

    const normalizedTag = normalizeTag(tag)
    if (!normalizedTag) {
      continue
    }

    if (!deduped.has(normalizedTag.normalized)) {
      deduped.set(normalizedTag.normalized, normalizedTag)
    }
  }

  return Array.from(deduped.values())
}

async function getTagsByUsernameIds(
  db: D1Database,
  usernameIds: number[]
): Promise<Map<number, string[]>> {
  const tagsByUsernameId = new Map<number, string[]>()

  if (usernameIds.length === 0) {
    return tagsByUsernameId
  }

  const placeholders = usernameIds.map(() => '?').join(', ')
  const result = await db.prepare(
    `SELECT username_id, tag_display
     FROM username_tags
     WHERE username_id IN (${placeholders})
     ORDER BY tag_normalized ASC, tag_display ASC`
  ).bind(...usernameIds).all<{ username_id: number; tag_display: string }>()

  for (const row of result.results) {
    const tags = tagsByUsernameId.get(row.username_id) || []
    tags.push(row.tag_display)
    tagsByUsernameId.set(row.username_id, tags)
  }

  return tagsByUsernameId
}

async function attachTags(
  db: D1Database,
  usernames: Username[]
): Promise<UsernameWithTags[]> {
  const tagsByUsernameId = await getTagsByUsernameIds(db, usernames.map((username) => username.id))

  return usernames.map((username) => ({
    ...username,
    tags: tagsByUsernameId.get(username.id) || []
  }))
}

async function countQuery(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<number> {
  const result = await db.prepare(sql).bind(...params).first<{ count: number }>()
  return result?.count || 0
}

export async function getUsernameDetail(
  db: D1Database,
  name: string
): Promise<UsernameWithTags | null> {
  const username = await getUsernameByName(db, name)
  if (!username) {
    return null
  }

  const [withTags] = await attachTags(db, [username])
  return withTags || null
}

export async function updateUsernameMetadata(
  db: D1Database,
  params: {
    name: string
    adminNotes: string | null
    tags: string[]
  }
): Promise<UsernameWithTags | null> {
  const username = await getUsernameByName(db, params.name)
  if (!username) {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  const normalized = normalizeTags(params.tags)

  await db.prepare(
    `UPDATE usernames
     SET admin_notes = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(params.adminNotes, now, username.id).run()

  await db.prepare(
    'DELETE FROM username_tags WHERE username_id = ?'
  ).bind(username.id).run()

  for (const tag of normalized) {
    await db.prepare(
      `INSERT INTO username_tags (username_id, tag_display, tag_normalized, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(username.id, tag.display, tag.normalized, now).run()
  }

  return getUsernameDetail(db, username.username_canonical || username.name)
}

export async function getUsernameStats(
  db: D1Database
): Promise<UsernameStats> {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - (7 * 24 * 60 * 60)
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60)

  const [
    all,
    active,
    reserved,
    revoked,
    burned,
    withNotes,
    withTags,
    untagged,
    vip,
    claimed7d,
    claimed30d,
    updated7d,
    updated30d,
    topTagsResult,
  ] = await Promise.all([
    countQuery(db, 'SELECT COUNT(*) AS count FROM usernames'),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE status = ?`, 'active'),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE status = ?`, 'reserved'),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE status = ?`, 'revoked'),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE status = ?`, 'burned'),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE admin_notes IS NOT NULL AND TRIM(admin_notes) != ''`),
    countQuery(db, `SELECT COUNT(DISTINCT username_id) AS count FROM username_tags`),
    countQuery(
      db,
      `SELECT COUNT(*) AS count
       FROM usernames
       WHERE NOT EXISTS (
         SELECT 1 FROM username_tags WHERE username_tags.username_id = usernames.id
       )`
    ),
    countQuery(db, `SELECT COUNT(DISTINCT username_id) AS count FROM username_tags WHERE tag_normalized = ?`, 'vip'),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE claimed_at IS NOT NULL AND claimed_at >= ?`, sevenDaysAgo),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE claimed_at IS NOT NULL AND claimed_at >= ?`, thirtyDaysAgo),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE updated_at >= ?`, sevenDaysAgo),
    countQuery(db, `SELECT COUNT(*) AS count FROM usernames WHERE updated_at >= ?`, thirtyDaysAgo),
    db.prepare(
      `SELECT tag_normalized AS tag, COUNT(*) AS count
       FROM username_tags
       GROUP BY tag_normalized
       ORDER BY count DESC, tag_normalized ASC
       LIMIT 10`
    ).bind().all<{ tag: string; count: number }>(),
  ])

  return {
    totals: {
      all,
      active,
      reserved,
      revoked,
      burned,
    },
    metadata: {
      with_notes: withNotes,
      with_tags: withTags,
      untagged,
      vip,
    },
    activity: {
      claimed_7d: claimed7d,
      claimed_30d: claimed30d,
      updated_7d: updated7d,
      updated_30d: updated30d,
    },
    top_tags: topTagsResult.results,
  }
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
    `INSERT INTO usernames (name, username_display, username_canonical, pubkey, relays, status, claim_source, created_at, updated_at, claimed_at)
     VALUES (?, ?, ?, ?, ?, 'active', 'self-service', ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       name = excluded.name,
       username_display = excluded.username_display,
       pubkey = excluded.pubkey,
       relays = excluded.relays,
       status = 'active',
       claim_source = 'self-service',
       created_by = NULL,
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
  reason: string,
  claimSource: ClaimSource,
  createdBy: string | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await db.prepare(
    `INSERT INTO usernames (name, username_display, username_canonical, status, reserved_reason, claim_source, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       name = excluded.name,
       username_display = excluded.username_display,
       status = 'reserved',
       reserved_reason = excluded.reserved_reason,
       claim_source = excluded.claim_source,
       created_by = excluded.created_by,
       updated_at = excluded.updated_at`
  ).bind(nameCanonical, nameDisplay, nameCanonical, reason, claimSource, createdBy, now, now).run()
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
  pubkey: string,
  claimSource: ClaimSource,
  createdBy: string | null
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
    `INSERT INTO usernames (name, username_display, username_canonical, pubkey, status, claim_source, created_by, created_at, updated_at, claimed_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       name = excluded.name,
       username_display = excluded.username_display,
       pubkey = excluded.pubkey,
       status = 'active',
       claim_source = excluded.claim_source,
       created_by = excluded.created_by,
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(nameCanonical, nameDisplay, nameCanonical, pubkey, claimSource, createdBy, now, now, now).run()
}

function escapeLikePattern(str: string): string {
  // Escape special LIKE characters (% and _) to prevent injection
  return str.replace(/[%_]/g, '\\$&')
}

export async function searchUsernames(
  db: D1Database,
  params: SearchParams
): Promise<SearchResult> {
  const { query, status, sort = 'relevance', page = 1, limit = 50 } = params
  const offset = (page - 1) * limit
  const whereParts: string[] = []
  const queryParams: unknown[] = []
  const trimmedQuery = query.trim()
  const normalizedQuery = trimmedQuery.toLowerCase()

  if (trimmedQuery) {
    const escapedQuery = escapeLikePattern(normalizedQuery)
    const searchPattern = `%${escapedQuery}%`
    whereParts.push(`(
      LOWER(COALESCE(name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(username_display, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(username_canonical, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(pubkey, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(email, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(admin_notes, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM username_tags ut
        WHERE ut.username_id = usernames.id
          AND (
            LOWER(COALESCE(ut.tag_display, '')) LIKE ? ESCAPE '\\'
            OR LOWER(COALESCE(ut.tag_normalized, '')) LIKE ? ESCAPE '\\'
          )
      )
    )`)
    queryParams.push(
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern
    )
  }

  // Add status filter if provided
  if (status === 'recovered') {
    // "Recovered" = Vine accounts that have been claimed (active with pubkey, originally from Vine import)
    const recoveredCondition = `status = 'active' AND pubkey IS NOT NULL AND reserved_reason LIKE '%Vine%'`
    whereParts.push(recoveredCondition)
  } else if (status) {
    whereParts.push('status = ?')
    queryParams.push(status)
  }

  const whereClause = whereParts.length > 0 ? whereParts.join(' AND ') : '1=1'

  // Get total count
  const countResult = await db.prepare(
    `SELECT COUNT(*) as count FROM usernames WHERE ${whereClause}`
  ).bind(...queryParams).first<{ count: number }>()

  const total = countResult?.count || 0
  const totalPages = Math.ceil(total / limit)

  let orderClause = 'created_at DESC'
  const orderParams: unknown[] = []

  if (sort === 'oldest') {
    orderClause = 'created_at ASC'
  } else if (sort === 'updated') {
    orderClause = 'updated_at DESC, created_at DESC'
  } else if (sort === 'newest') {
    orderClause = 'created_at DESC'
  } else if (trimmedQuery) {
    const escapedQuery = escapeLikePattern(normalizedQuery)
    const prefixPattern = `${escapedQuery}%`
    const containsPattern = `%${escapedQuery}%`
    orderClause = `CASE
      WHEN LOWER(COALESCE(username_canonical, '')) = ? THEN 0
      WHEN LOWER(COALESCE(username_display, '')) = ? THEN 1
      WHEN LOWER(COALESCE(username_canonical, '')) LIKE ? ESCAPE '\\' THEN 2
      WHEN LOWER(COALESCE(username_display, '')) LIKE ? ESCAPE '\\' THEN 3
      WHEN EXISTS (
        SELECT 1 FROM username_tags ut
        WHERE ut.username_id = usernames.id
          AND LOWER(COALESCE(ut.tag_normalized, '')) = ?
      ) THEN 4
      WHEN EXISTS (
        SELECT 1 FROM username_tags ut
        WHERE ut.username_id = usernames.id
          AND LOWER(COALESCE(ut.tag_normalized, '')) LIKE ? ESCAPE '\\'
      ) THEN 5
      WHEN LOWER(COALESCE(pubkey, '')) = ? OR LOWER(COALESCE(email, '')) = ? THEN 6
      WHEN LOWER(COALESCE(pubkey, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(email, '')) LIKE ? ESCAPE '\\' THEN 7
      WHEN LOWER(COALESCE(admin_notes, '')) LIKE ? ESCAPE '\\' THEN 8
      ELSE 9
    END, updated_at DESC, created_at DESC`
    orderParams.push(
      normalizedQuery,
      normalizedQuery,
      prefixPattern,
      prefixPattern,
      normalizedQuery,
      containsPattern,
      normalizedQuery,
      normalizedQuery,
      containsPattern,
      containsPattern,
      containsPattern
    )
  }

  // Get paginated results
  const results = await db.prepare(
    `SELECT * FROM usernames
     WHERE ${whereClause}
     ORDER BY ${orderClause}
     LIMIT ? OFFSET ?`
  ).bind(...queryParams, ...orderParams, limit, offset).all<Username>()

  const withTags = await attachTags(db, results.results)

  return {
    results: withTags,
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
  status?: 'active' | 'reserved' | 'revoked' | 'burned' | 'recovered'
): Promise<Username[]> {
  if (status === 'recovered') {
    const result = await db.prepare(
      `SELECT * FROM usernames WHERE status = 'active' AND pubkey IS NOT NULL AND reserved_reason LIKE '%Vine%' ORDER BY claimed_at DESC, name`
    ).all<Username>()
    return result.results
  }

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

export async function countRecentReservationsByEmail(
  db: D1Database,
  email: string,
  since: number
): Promise<number> {
  const result = await db.prepare(
    'SELECT COUNT(*) as count FROM reservation_tokens WHERE email = ? AND created_at > ?'
  ).bind(email.toLowerCase(), since).first<{ count: number }>()

  return result?.count ?? 0
}

export async function createReservation(
  db: D1Database,
  nameDisplay: string,
  nameCanonical: string,
  email: string,
  token: string,
  expiresAt: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const normalizedEmail = email.toLowerCase()

  // Upsert username record with pending-confirmation status
  await db.prepare(
    `INSERT INTO usernames (name, username_display, username_canonical, status, claim_source, reservation_email, confirmation_token, reservation_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending-confirmation', 'public-reservation', ?, ?, ?, ?, ?)
     ON CONFLICT(username_canonical) DO UPDATE SET
       username_display = excluded.username_display,
       status = 'pending-confirmation',
       claim_source = 'public-reservation',
       created_by = NULL,
       reservation_email = excluded.reservation_email,
       confirmation_token = excluded.confirmation_token,
       reservation_expires_at = excluded.reservation_expires_at,
       updated_at = excluded.updated_at`
  ).bind(nameCanonical, nameDisplay, nameCanonical, normalizedEmail, token, expiresAt, now, now).run()

  // Insert token record for rate limiting and confirmation tracking
  await db.prepare(
    `INSERT INTO reservation_tokens (token, username_canonical, email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(token, nameCanonical, normalizedEmail, now, expiresAt).run()
}

export async function getReservationByToken(
  db: D1Database,
  token: string
): Promise<ReservationToken | null> {
  return db.prepare(
    'SELECT * FROM reservation_tokens WHERE token = ?'
  ).bind(token).first<ReservationToken>()
}

export async function confirmReservation(
  db: D1Database,
  token: string,
  usernameCanonical: string,
  subscriptionExpiresAt: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  // Mark token as confirmed
  await db.prepare(
    'UPDATE reservation_tokens SET confirmed_at = ? WHERE token = ?'
  ).bind(now, token).run()

  // Promote username from pending-confirmation to reserved with subscription expiry
  await db.prepare(
    `UPDATE usernames
     SET status = 'reserved',
         confirmation_token = NULL,
         subscription_expires_at = ?,
         updated_at = ?
     WHERE username_canonical = ? AND status = 'pending-confirmation'`
  ).bind(subscriptionExpiresAt, now, usernameCanonical).run()
}

export interface SpentCashuProof {
  proof_secret: string
  cashu_token_hash: string
  username_canonical: string
  amount: number
  created_at: number
}

export interface CashuProofRecord {
  secret: string
  amount: number
}

// Check which proof secrets from the given list are already spent
export async function findSpentProofs(
  db: D1Database,
  secrets: string[]
): Promise<string[]> {
  if (secrets.length === 0) return []

  const spentSecrets: string[] = []
  for (const secret of secrets) {
    const result = await db.prepare(
      'SELECT proof_secret FROM spent_cashu_proofs WHERE proof_secret = ?'
    ).bind(secret).first<{ proof_secret: string }>()
    if (result) {
      spentSecrets.push(secret)
    }
  }
  return spentSecrets
}

// Store proof secrets as spent to prevent replay attacks
export async function storeSpentProofs(
  db: D1Database,
  proofs: CashuProofRecord[],
  tokenHash: string,
  usernameCanonical: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  for (const proof of proofs) {
    await db.prepare(
      `INSERT OR IGNORE INTO spent_cashu_proofs
       (proof_secret, cashu_token_hash, username_canonical, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(proof.secret, tokenHash, usernameCanonical, proof.amount, now).run()
  }
}

export async function expireStaleReservations(
  db: D1Database
): Promise<number> {
  const now = Math.floor(Date.now() / 1000)

  const result = await db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         confirmation_token = NULL,
         reservation_email = NULL,
         reservation_expires_at = NULL,
         revoked_at = ?,
         updated_at = ?
     WHERE status = 'pending-confirmation' AND reservation_expires_at < ?`
  ).bind(now, now, now).run()

  return result.meta?.changes ?? 0
}
