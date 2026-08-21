// ABOUTME: Database query helpers for usernames and reserved words
// ABOUTME: Provides type-safe D1 database operations

import type { SyncItem, UsernameKVData } from '../utils/fastly-sync'
import { validateAndNormalizePubkey } from '../utils/validation'

// SQLite raises "LIKE or GLOB pattern too complex" once a LIKE pattern exceeds
// SQLITE_MAX_LIKE_PATTERN_LENGTH (50). Our search wraps the term as `%term%`,
// so any term longer than 48 chars would overflow it.
const MAX_LIKE_PATTERN_LENGTH = 50

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
  status: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation' | 'pending-release'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
  admin_notes_updated_by: string | null
  admin_notes_updated_at: number | null
  reservation_email: string | null
  confirmation_token: string | null
  reservation_expires_at: number | null
  subscription_expires_at: number | null
  claim_source: ClaimSource
  created_by: string | null
  atproto_did: string | null
  atproto_state: 'pending' | 'ready' | 'failed' | 'disabled' | null
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
  status?: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation' | 'pending-release' | 'recovered'
  tag?: string
  sort?: SearchSort
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

export interface FastlySyncQueueTask extends SyncItem {
  generation: number
  queued_at: number
  updated_at: number
  last_attempt_at: number | null
  attempt_count: number
  last_error: string | null
}

export type ReleaseAttemptState = 'pending' | 'cancelled' | 'finalized' | 'expired-restored'

export interface UsernameReleaseAttempt {
  attempt_id: string
  username_canonical: string
  pubkey: string
  state: ReleaseAttemptState
  created_at: number
  updated_at: number
  expires_at: number
  cancelled_at: number | null
  finalized_at: number | null
  finalized_by: string | null
}

export interface RestoreUsernameResult {
  username: Username
  releasedUsernameCanonical: string | null
  ownerChanged: boolean
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
    'SELECT * FROM usernames WHERE LOWER(pubkey) = LOWER(?) AND status = ?'
  ).bind(pubkey, 'active').first<Username>()

  return result
}

export async function getReleaseAttemptById(
  db: D1Database,
  attemptId: string
): Promise<UsernameReleaseAttempt | null> {
  return db.prepare(
    'SELECT * FROM username_release_attempts WHERE attempt_id = ?'
  ).bind(attemptId).first<UsernameReleaseAttempt>()
}

export async function getLatestReleaseAttemptByPubkey(
  db: D1Database,
  pubkey: string
): Promise<UsernameReleaseAttempt | null> {
  // A pubkey has at most one pending attempt (partial unique index), and callers
  // gate on that state. created_at is whole seconds, so a cancel-and-retry inside
  // one second ties and falls through to attempt_id, which is client-chosen and
  // could surface the cancelled attempt instead. Rank pending first.
  return db.prepare(
    `SELECT * FROM username_release_attempts
     WHERE LOWER(pubkey) = LOWER(?)
     ORDER BY (state = 'pending') DESC, created_at DESC, attempt_id DESC LIMIT 1`
  ).bind(pubkey).first<UsernameReleaseAttempt>()
}

export type ReleaseTransitionResult =
  | { outcome: 'transitioned' | 'replayed'; attempt: UsernameReleaseAttempt; username: Username }
  | { outcome: 'conflict'; attempt?: UsernameReleaseAttempt }
  | { outcome: 'not_found'; attempt?: UsernameReleaseAttempt }

export async function prepareReleaseAttempt(
  db: D1Database,
  pubkey: string,
  usernameCanonical: string,
  attemptId: string,
  expiresAt: number,
  now = Math.floor(Date.now() / 1000)
): Promise<ReleaseTransitionResult> {
  const existing = await getReleaseAttemptById(db, attemptId)
  if (existing) {
    if (existing.pubkey.toLowerCase() !== pubkey.toLowerCase() || existing.username_canonical !== usernameCanonical) {
      return { outcome: 'conflict' }
    }
    const username = await getUsernameByName(db, usernameCanonical)
    if (existing.state === 'pending' && username?.status === 'pending-release') {
      return { outcome: 'replayed', attempt: existing, username }
    }
    return { outcome: 'conflict', attempt: existing }
  }

  const insertAttempt = db.prepare(
    `INSERT OR IGNORE INTO username_release_attempts (
       attempt_id, username_canonical, pubkey, state, created_at, updated_at, expires_at
     )
     SELECT ?, username_canonical, pubkey, 'pending', ?, ?, ?
     FROM usernames
     WHERE username_canonical = ? AND LOWER(pubkey) = LOWER(?) AND status = 'active'`
  ).bind(attemptId, now, now, expiresAt, usernameCanonical, pubkey)
  const markPending = db.prepare(
    `UPDATE usernames
     SET status = 'pending-release', updated_at = ?
     WHERE username_canonical = ? AND LOWER(pubkey) = LOWER(?) AND status = 'active'
       AND EXISTS (
         SELECT 1 FROM username_release_attempts
         WHERE attempt_id = ? AND username_canonical = ?
           AND LOWER(pubkey) = LOWER(?) AND state = 'pending'
       )`
  ).bind(now, usernameCanonical, pubkey, attemptId, usernameCanonical, pubkey)

  const [insertResult, updateResult] = await db.batch([insertAttempt, markPending])
  const attempt = await getReleaseAttemptById(db, attemptId)
  const username = await getUsernameByName(db, usernameCanonical)
  if (!insertResult.meta?.changes || !updateResult.meta?.changes) {
    if (attempt && attempt.pubkey.toLowerCase() === pubkey.toLowerCase() &&
        attempt.username_canonical === usernameCanonical && attempt.state === 'pending' &&
        username?.status === 'pending-release') {
      return { outcome: 'replayed', attempt, username }
    }
    const pendingForPubkey = await getLatestReleaseAttemptByPubkey(db, pubkey)
    return pendingForPubkey?.state === 'pending' || attempt ? { outcome: 'conflict', attempt: attempt || undefined } : { outcome: 'not_found' }
  }
  if (!attempt || !username) return { outcome: 'not_found' }
  return { outcome: 'transitioned', attempt, username }
}

export async function rollbackReleaseAttempt(
  db: D1Database,
  pubkey: string,
  usernameCanonical: string,
  attemptId: string,
  terminalState: 'cancelled' | 'expired-restored' = 'cancelled',
  now = Math.floor(Date.now() / 1000)
): Promise<ReleaseTransitionResult> {
  const existing = await getReleaseAttemptById(db, attemptId)
  if (!existing) return { outcome: 'not_found' }
  if (existing.pubkey.toLowerCase() !== pubkey.toLowerCase() || existing.username_canonical !== usernameCanonical) {
    return { outcome: 'conflict' }
  }
  const currentUsername = await getUsernameByName(db, usernameCanonical)
  if (existing.state === terminalState && currentUsername?.status === 'active') {
    return { outcome: 'replayed', attempt: existing, username: currentUsername }
  }
  if (existing.state !== 'pending') return { outcome: 'conflict', attempt: existing }

  const restore = db.prepare(
    `UPDATE usernames SET status = 'active', revoked_at = NULL, updated_at = ?
     WHERE username_canonical = ? AND LOWER(pubkey) = LOWER(?) AND status = 'pending-release'
       AND EXISTS (SELECT 1 FROM username_release_attempts WHERE attempt_id = ? AND state = 'pending')`
  ).bind(now, usernameCanonical, pubkey, attemptId)
  const finishAttempt = db.prepare(
    `UPDATE username_release_attempts
     SET state = ?, updated_at = ?, cancelled_at = ?
     WHERE attempt_id = ? AND state = 'pending'
       AND EXISTS (SELECT 1 FROM usernames WHERE username_canonical = ? AND status = 'active')`
  ).bind(terminalState, now, now, attemptId, usernameCanonical)
  const [restoreResult, attemptResult] = await db.batch([restore, finishAttempt])
  const attempt = await getReleaseAttemptById(db, attemptId)
  const username = await getUsernameByName(db, usernameCanonical)
  if (!restoreResult.meta?.changes || !attemptResult.meta?.changes) {
    if (attempt?.state === terminalState && username?.status === 'active') {
      return { outcome: 'replayed', attempt, username }
    }
    return { outcome: 'conflict', attempt: attempt || undefined }
  }
  if (!attempt || !username) return { outcome: 'conflict' }
  return { outcome: 'transitioned', attempt, username }
}

export async function finalizeReleaseAttempt(
  db: D1Database,
  attemptId: string,
  finalizedBy: string,
  now = Math.floor(Date.now() / 1000)
): Promise<ReleaseTransitionResult> {
  const existing = await getReleaseAttemptById(db, attemptId)
  if (!existing) return { outcome: 'not_found' }
  const currentUsername = await getUsernameByName(db, existing.username_canonical)
  if (existing.state === 'finalized' && currentUsername?.status === 'burned') {
    return { outcome: 'replayed', attempt: existing, username: currentUsername }
  }
  if (existing.state !== 'pending') return { outcome: 'conflict', attempt: existing }
  if (existing.expires_at <= now) return { outcome: 'conflict', attempt: existing }

  const burn = db.prepare(
    `UPDATE usernames
     SET status = 'burned', recyclable = 0, revoked_at = ?, updated_at = ?
     WHERE username_canonical = ? AND LOWER(pubkey) = LOWER(?) AND status = 'pending-release'
       AND EXISTS (
         SELECT 1 FROM username_release_attempts
         WHERE attempt_id = ? AND state = 'pending' AND expires_at > ?
       )`
  ).bind(now, now, existing.username_canonical, existing.pubkey, attemptId, now)
  const finishAttempt = db.prepare(
    `UPDATE username_release_attempts
     SET state = 'finalized', updated_at = ?, finalized_at = ?, finalized_by = ?
     WHERE attempt_id = ? AND state = 'pending'
       AND EXISTS (SELECT 1 FROM usernames WHERE username_canonical = ? AND status = 'burned')`
  ).bind(now, now, finalizedBy, attemptId, existing.username_canonical)
  const [burnResult, attemptResult] = await db.batch([burn, finishAttempt])
  const attempt = await getReleaseAttemptById(db, attemptId)
  const username = await getUsernameByName(db, existing.username_canonical)
  if (!burnResult.meta?.changes || !attemptResult.meta?.changes) {
    if (attempt?.state === 'finalized' && username?.status === 'burned') {
      return { outcome: 'replayed', attempt, username }
    }
    return { outcome: 'conflict', attempt: attempt || undefined }
  }
  if (!attempt || !username) return { outcome: 'conflict' }
  return { outcome: 'transitioned', attempt, username }
}

export async function getStaleReleaseAttempts(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  limit = 100
): Promise<UsernameReleaseAttempt[]> {
  const result = await db.prepare(
    `SELECT * FROM username_release_attempts
     WHERE state = 'pending' AND expires_at <= ?
     ORDER BY expires_at ASC LIMIT ?`
  ).bind(now, limit).all<UsernameReleaseAttempt>()
  return result.results
}

export async function listReleaseAttempts(
  db: D1Database,
  state?: ReleaseAttemptState,
  limit = 100
): Promise<UsernameReleaseAttempt[]> {
  const statement = state
    ? db.prepare(`SELECT * FROM username_release_attempts WHERE state = ? ORDER BY updated_at DESC LIMIT ?`).bind(state, limit)
    : db.prepare(`SELECT * FROM username_release_attempts ORDER BY updated_at DESC LIMIT ?`).bind(limit)
  const result = await statement.all<UsernameReleaseAttempt>()
  return result.results
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

  // Keep the release and claim in one D1 transaction. The EXISTS predicate is
  // repeated in both statements so an unavailable (including pending-release)
  // target can never cause the caller's current name to be revoked.
  const releaseCurrent = db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE LOWER(pubkey) = LOWER(?) AND status = 'active'
       AND username_canonical != ?
       AND (
         NOT EXISTS (SELECT 1 FROM usernames WHERE username_canonical = ?)
         OR EXISTS (
           SELECT 1 FROM usernames
           WHERE username_canonical = ?
             AND (status = 'revoked' OR (status = 'active' AND LOWER(pubkey) = LOWER(?)))
         )
       )`
  ).bind(now, now, pubkey, nameCanonical, nameCanonical, nameCanonical, pubkey)

  // Then insert or update the new username using canonical for uniqueness
  const claimTarget = db.prepare(
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
       revoked_at = NULL,
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at
     WHERE usernames.status = 'revoked'
        OR (usernames.status = 'active' AND LOWER(usernames.pubkey) = LOWER(excluded.pubkey))`
  ).bind(nameCanonical, nameDisplay, nameCanonical, pubkey, relaysJson, now, now, now)

  const [, claimResult] = await db.batch([releaseCurrent, claimTarget])
  if (!claimResult.meta || claimResult.meta.changes === 0) {
    throw new Error('USERNAME_NOT_CLAIMABLE')
  }
}

export async function getActiveUsernamesPaginated(
  db: D1Database,
  afterId: number | null,
  limit: number
): Promise<Username[]> {
  if (afterId !== null) {
    const result = await db.prepare(
      'SELECT * FROM usernames WHERE status = ? AND id > ? ORDER BY id LIMIT ?'
    ).bind('active', afterId, limit).all<Username>()
    return result.results
  }
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE status = ? ORDER BY id LIMIT ?'
  ).bind('active', limit).all<Username>()
  return result.results
}

export async function countActiveUsernames(
  db: D1Database,
  afterId?: number | null
): Promise<number> {
  if (afterId !== undefined && afterId !== null) {
    const result = await db.prepare(
      'SELECT COUNT(*) as count FROM usernames WHERE status = ? AND id > ?'
    ).bind('active', afterId).first<{ count: number }>()
    return result?.count ?? 0
  }
  const result = await db.prepare(
    'SELECT COUNT(*) as count FROM usernames WHERE status = ?'
  ).bind('active').first<{ count: number }>()
  return result?.count ?? 0
}

export async function getUsernamesUpdatedSince(
  db: D1Database,
  sinceEpoch: number
): Promise<Username[]> {
  const result = await db.prepare(
    `SELECT * FROM usernames WHERE updated_at >= ? AND status IN ('active', 'revoked', 'burned', 'pending-release')`
  ).bind(sinceEpoch).all<Username>()

  return result.results
}

export async function enqueueFastlySyncTask(
  db: D1Database,
  item: SyncItem,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  const payloadJson = item.data ? JSON.stringify(item.data) : null

  await db.prepare(
    `INSERT INTO fastly_sync_queue (
       username_canonical, action, payload_json, queued_at, updated_at, last_attempt_at, attempt_count, last_error, generation
     ) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, 1)
     ON CONFLICT(username_canonical) DO UPDATE SET
       action = excluded.action,
       payload_json = excluded.payload_json,
       queued_at = CASE
         WHEN fastly_sync_queue.action != excluded.action
           OR COALESCE(fastly_sync_queue.payload_json, '') != COALESCE(excluded.payload_json, '')
         THEN excluded.queued_at
         ELSE fastly_sync_queue.queued_at
       END,
       updated_at = excluded.updated_at,
       generation = CASE
         WHEN fastly_sync_queue.action != excluded.action
           OR COALESCE(fastly_sync_queue.payload_json, '') != COALESCE(excluded.payload_json, '')
         THEN fastly_sync_queue.generation + 1
         ELSE fastly_sync_queue.generation
       END,
       last_attempt_at = CASE
         WHEN fastly_sync_queue.action != excluded.action
           OR COALESCE(fastly_sync_queue.payload_json, '') != COALESCE(excluded.payload_json, '')
         THEN NULL
         ELSE fastly_sync_queue.last_attempt_at
       END,
       attempt_count = CASE
         WHEN fastly_sync_queue.action != excluded.action
           OR COALESCE(fastly_sync_queue.payload_json, '') != COALESCE(excluded.payload_json, '')
         THEN 0
         ELSE fastly_sync_queue.attempt_count
       END,
       last_error = CASE
         WHEN fastly_sync_queue.action != excluded.action
           OR COALESCE(fastly_sync_queue.payload_json, '') != COALESCE(excluded.payload_json, '')
         THEN NULL
         ELSE fastly_sync_queue.last_error
       END`
  ).bind(item.username, item.action, payloadJson, now, now).run()
}

export async function getQueuedFastlySyncTasks(
  db: D1Database,
  limit = 1000
): Promise<FastlySyncQueueTask[]> {
  const result = await db.prepare(
    `SELECT username_canonical, action, payload_json, queued_at, updated_at, last_attempt_at, attempt_count, last_error, generation
     FROM fastly_sync_queue
     ORDER BY updated_at ASC
     LIMIT ?`
  ).bind(limit).all<{
    username_canonical: string
    action: 'sync' | 'delete'
    payload_json: string | null
    queued_at: number
    updated_at: number
    last_attempt_at: number | null
    attempt_count: number
    last_error: string | null
    generation: number
  }>()

  return result.results.map((row) => ({
    username: row.username_canonical,
    action: row.action,
    data: row.payload_json ? JSON.parse(row.payload_json) as UsernameKVData : undefined,
    queued_at: row.queued_at,
    updated_at: row.updated_at,
    last_attempt_at: row.last_attempt_at,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    generation: row.generation,
  }))
}

export async function getQueuedFastlySyncTask(
  db: D1Database,
  usernameCanonical: string
): Promise<FastlySyncQueueTask | null> {
  const tasks = await db.prepare(
    `SELECT username_canonical, action, payload_json, queued_at, updated_at,
            last_attempt_at, attempt_count, last_error, generation
     FROM fastly_sync_queue WHERE username_canonical = ?`
  ).bind(usernameCanonical).all<{
    username_canonical: string
    action: 'sync' | 'delete'
    payload_json: string | null
    queued_at: number
    updated_at: number
    last_attempt_at: number | null
    attempt_count: number
    last_error: string | null
    generation: number
  }>()
  const row = tasks.results[0]
  if (!row) return null
  return {
    username: row.username_canonical,
    action: row.action,
    data: row.payload_json ? JSON.parse(row.payload_json) as UsernameKVData : undefined,
    queued_at: row.queued_at,
    updated_at: row.updated_at,
    last_attempt_at: row.last_attempt_at,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    generation: row.generation,
  }
}

export async function clearFastlySyncTasks(
  db: D1Database,
  tasks: Array<{ username: string; generation: number }>
): Promise<void> {
  if (tasks.length === 0) return

  // Generation scoping needs a predicate per task, so this can no longer be one
  // IN (...) delete. Send them together anyway: the hourly cron reads up to 5000
  // queued tasks, and one round trip each would dominate the run.
  const statements = tasks.map((task) =>
    db.prepare(
      'DELETE FROM fastly_sync_queue WHERE username_canonical = ? AND generation = ?'
    ).bind(task.username, task.generation)
  )

  if (typeof (db as { batch?: unknown }).batch === 'function') {
    for (let i = 0; i < statements.length; i += 500) {
      await db.batch(statements.slice(i, i + 500))
    }
    return
  }

  for (const statement of statements) {
    await statement.run()
  }
}

export async function markFastlySyncTaskFailures(
  db: D1Database,
  failures: Array<{ username: string; error: string }>,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (failures.length === 0) return

  const batched = (db as D1Database & { batch?: (statements: D1PreparedStatement[]) => Promise<unknown> }).batch
  if (typeof batched === 'function') {
    const statements = failures.map((failure) =>
      db.prepare(
        `UPDATE fastly_sync_queue
         SET last_attempt_at = ?, attempt_count = attempt_count + 1, last_error = ?
         WHERE username_canonical = ?`
      ).bind(now, failure.error, failure.username)
    )
    await batched(statements)
    return
  }

  for (const failure of failures) {
    await db.prepare(
      `UPDATE fastly_sync_queue
       SET last_attempt_at = ?, attempt_count = attempt_count + 1, last_error = ?
       WHERE username_canonical = ?`
    ).bind(now, failure.error, failure.username).run()
  }
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
       revoked_at = NULL,
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

/**
 * Revoke/burn a username scoped to a specific pubkey.
 *
 * Unlike revokeUsername (which matches `username_canonical = ? OR name = ?`
 * for admin use, where naming either column is intentional), this only ever
 * touches the row owned by `pubkey`. A self-service `/release` caller must not
 * be able to collaterally burn a *different* user's globally-unique row when a
 * legacy `name != canonical` row's `name` happens to equal the caller's
 * canonical.
 */
export async function revokeUsernameByPubkey(
  db: D1Database,
  pubkey: string,
  canonical: string,
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
     WHERE username_canonical = ? AND LOWER(pubkey) = LOWER(?)`
  ).bind(status, recyclable, now, now, canonical, pubkey).run()
}

/**
 * Restore a previously revoked or burned username to a specific pubkey.
 *
 * Sets status='active', recyclable=1, pubkey=<provided>, clears revoked_at,
 * resets claimed_at to now, and appends an audit line to admin_notes.
 *
 * Releases any other active username currently held by the target pubkey
 * (mirrors assignUsername) so the partial unique index on (pubkey,status='active')
 * is not violated.
 */
export async function restoreUsername(
  db: D1Database,
  nameCanonical: string,
  pubkey: string,
  reason: string | null,
  restoredBy: string | null
): Promise<RestoreUsernameResult | null> {
  const now = Math.floor(Date.now() / 1000)

  const existing = await getUsernameByName(db, nameCanonical)
  if (!existing) return null
  if (existing.status !== 'revoked' && existing.status !== 'burned') return null

  const auditLine = `[${new Date(now * 1000).toISOString()} restored by ${restoredBy || 'unknown'}]${reason ? `: ${reason}` : ''}`
  const newNotes = existing.admin_notes && existing.admin_notes.length > 0
    ? `${existing.admin_notes}\n${auditLine}`
    : auditLine

  // Pre-batch read: the name the batch will release, so the caller can delete its
  // stale Fastly edge record. If a concurrent same-pubkey claim lands between this
  // read and the batch, the reported released name can lag the actually-revoked one
  // by a sync cycle; the DB stays correct (transactional batch + partial unique
  // index) and nip05-status / the Fastly sync queue self-heal the edge.
  const existingActiveForPubkey = await getUsernameByPubkey(db, pubkey)
  const releasedUsernameCanonical = existingActiveForPubkey?.username_canonical &&
    existingActiveForPubkey.username_canonical !== nameCanonical
    ? existingActiveForPubkey.username_canonical
    : null
  const ownerChanged = existing.pubkey?.toLowerCase() !== pubkey.toLowerCase()
  const relays = ownerChanged ? null : existing.relays
  const atprotoDid = ownerChanged ? null : existing.atproto_did
  const atprotoState = ownerChanged ? null : existing.atproto_state

  const releaseStatement = db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE LOWER(pubkey) = LOWER(?)
       AND status = 'active'
       AND username_canonical != ?
       AND EXISTS (
         SELECT 1 FROM usernames
         WHERE username_canonical = ? AND status IN ('revoked', 'burned')
       )`
  ).bind(now, now, pubkey, nameCanonical, nameCanonical)

  const restoreStatement = db.prepare(
    `UPDATE usernames
     SET status = 'active',
         recyclable = 1,
         revoked_at = NULL,
         relays = ?,
         atproto_did = ?,
         atproto_state = ?,
         pubkey = ?,
         claimed_at = ?,
         updated_at = ?,
         admin_notes = ?,
         admin_notes_updated_by = ?,
         admin_notes_updated_at = ?
     WHERE username_canonical = ? AND status IN ('revoked', 'burned')`
  ).bind(relays, atprotoDid, atprotoState, pubkey, now, now, newNotes, restoredBy, now, nameCanonical)

  const [, restoreResult] = await db.batch([releaseStatement, restoreStatement])
  if (!restoreResult.meta || restoreResult.meta.changes === 0) return null

  const username = await getUsernameByName(db, nameCanonical)
  if (!username) return null

  return { username, releasedUsernameCanonical, ownerChanged }
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

  // Revoke existing username for this pubkey.
  // Legacy rows may contain mixed-case hex pubkeys, so match case-insensitively.
  await db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE LOWER(pubkey) = LOWER(?) AND status = 'active'`
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
       revoked_at = NULL,
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
  const trimmedQuery = query ? query.trim() : ''

  // A full public key (hex or npub) is an exact identity, and wrapped as
  // `%<key>%` its LIKE pattern overflows SQLite's limit. Match pubkey exactly
  // instead — which is also what an admin means by pasting a whole key.
  let pubkeyExact: string | null = null
  if (trimmedQuery.startsWith('npub1') || /^[0-9a-f]{64}$/i.test(trimmedQuery)) {
    try {
      pubkeyExact = validateAndNormalizePubkey(trimmedQuery)
    } catch {
      pubkeyExact = null
    }
  }

  // A non-pubkey query (full pubkeys are handled above) can only be served as a
  // `%term%` substring match, which SQLite refuses once the pattern exceeds the
  // cap ("LIKE or GLOB pattern too complex"). Return empty rather than error.
  // Known casualty: a >48-char email/admin_notes fragment can't be searched.
  if (!pubkeyExact && trimmedQuery && escapeLikePattern(trimmedQuery).length + 2 > MAX_LIKE_PATTERN_LENGTH) {
    return {
      results: [],
      pagination: { page, limit, total: 0, total_pages: 0 },
    }
  }

  // Build WHERE clause
  let whereClause = ''
  const queryParams: any[] = []
  const escapedQuery = !pubkeyExact && trimmedQuery ? escapeLikePattern(trimmedQuery) : ''

  if (pubkeyExact) {
    // Exact pubkey match (hex or decoded npub). LOWER() mirrors every other
    // pubkey lookup in this file so legacy mixed-case hex rows still match.
    whereClause = 'LOWER(pubkey) = LOWER(?)'
    queryParams.push(pubkeyExact)
  } else if (escapedQuery) {
    // Search across name, pubkey, email, admin_notes, and tags
    const searchPattern = `%${escapedQuery}%`
    whereClause = `(name LIKE ? OR username_display LIKE ? OR username_canonical LIKE ? OR pubkey LIKE ? OR email LIKE ? OR admin_notes LIKE ? OR EXISTS (SELECT 1 FROM username_tags ut WHERE ut.username_id = usernames.id AND ut.tag LIKE ?))`
    queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern)
  }

  // Add status filter if provided
  if (status === 'recovered') {
    // "Recovered" = Vine accounts that have been claimed (active with pubkey, originally from Vine import)
    const recoveredCondition = `status = 'active' AND pubkey IS NOT NULL AND reserved_reason LIKE '%Vine%'`
    if (whereClause) {
      whereClause += ` AND ${recoveredCondition}`
    } else {
      whereClause = recoveredCondition
    }
  } else if (status) {
    if (whereClause) {
      whereClause += ` AND status = ?`
    } else {
      whereClause = `status = ?`
    }
    queryParams.push(status)
  }

  // Add tag filter if provided
  if (params.tag) {
    const tagFilter = `EXISTS (SELECT 1 FROM username_tags ut WHERE ut.username_id = usernames.id AND ut.tag = ?)`
    if (whereClause) {
      whereClause += ` AND ${tagFilter}`
    } else {
      whereClause = tagFilter
    }
    queryParams.push(params.tag.trim().toLowerCase())
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

  // Build ORDER BY clause based on sort parameter
  // Bind order: ...queryParams, ...orderParams, limit, offset
  let orderClause = 'created_at DESC'
  const orderParams: any[] = []

  if (sort === 'oldest') {
    orderClause = 'created_at ASC'
  } else if (sort === 'updated') {
    orderClause = 'updated_at DESC, created_at DESC'
  } else if (sort === 'newest') {
    orderClause = 'created_at DESC'
  } else if (escapedQuery) {
    // sort === 'relevance' with a search query: rank by match quality
    const canonical = trimmedQuery.toLowerCase()
    const prefixPattern = `${escapedQuery}%`
    const containsPattern = `%${escapedQuery}%`
    orderClause = `CASE
      WHEN username_canonical = ? THEN 0
      WHEN username_canonical LIKE ? THEN 1
      WHEN name LIKE ? OR username_display LIKE ? THEN 2
      WHEN EXISTS (SELECT 1 FROM username_tags ut WHERE ut.username_id = usernames.id AND ut.tag = ?) THEN 3
      WHEN EXISTS (SELECT 1 FROM username_tags ut WHERE ut.username_id = usernames.id AND ut.tag LIKE ?) THEN 4
      WHEN pubkey = ? OR email = ? THEN 5
      WHEN pubkey LIKE ? OR email LIKE ? THEN 6
      WHEN admin_notes LIKE ? THEN 7
      ELSE 8
    END, updated_at DESC, created_at DESC`
    orderParams.push(
      canonical, prefixPattern,
      containsPattern, containsPattern,
      canonical, containsPattern,
      canonical, canonical,
      containsPattern, containsPattern,
      containsPattern
    )
  }

  const results = await db.prepare(
    `SELECT * FROM usernames
     WHERE ${whereClause}
     ORDER BY ${orderClause}
     LIMIT ? OFFSET ?`
  ).bind(...queryParams, ...orderParams, limit, offset).all<Username>()

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
  status?: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation' | 'pending-release' | 'recovered'
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
       revoked_at = NULL,
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

// --- Tag functions ---

export async function addTag(
  db: D1Database,
  usernameId: number,
  tag: string,
  createdBy?: string
): Promise<void> {
  const normalized = tag.trim().toLowerCase()
  if (!normalized) throw new Error('Tag cannot be empty')
  if (normalized.length > 50) throw new Error('Tag too long (max 50 characters)')
  await db.prepare(
    'INSERT OR IGNORE INTO username_tags (username_id, tag, created_at, created_by) VALUES (?, ?, ?, ?)'
  ).bind(usernameId, normalized, Math.floor(Date.now() / 1000), createdBy || null).run()
}

export async function removeTag(
  db: D1Database,
  usernameId: number,
  tag: string
): Promise<void> {
  const normalized = tag.trim().toLowerCase()
  await db.prepare(
    'DELETE FROM username_tags WHERE username_id = ? AND tag = ?'
  ).bind(usernameId, normalized).run()
}

export interface TagDetail {
  tag: string
  created_at: number
  created_by: string | null
}

export async function getTagsForUsername(
  db: D1Database,
  usernameId: number
): Promise<string[]> {
  const result = await db.prepare(
    'SELECT tag FROM username_tags WHERE username_id = ? ORDER BY tag'
  ).bind(usernameId).all<{ tag: string }>()
  return result.results.map(r => r.tag)
}

export async function getTagDetailsForUsername(
  db: D1Database,
  usernameId: number
): Promise<TagDetail[]> {
  const result = await db.prepare(
    'SELECT tag, created_at, created_by FROM username_tags WHERE username_id = ? ORDER BY tag'
  ).bind(usernameId).all<TagDetail>()
  return result.results
}

export async function getTagsForUsernames(
  db: D1Database,
  usernameIds: number[]
): Promise<Map<number, string[]>> {
  if (usernameIds.length === 0) return new Map()
  const map = new Map<number, string[]>()
  // D1 has a 100-parameter bind limit per prepared statement
  const CHUNK_SIZE = 100
  for (let i = 0; i < usernameIds.length; i += CHUNK_SIZE) {
    const chunk = usernameIds.slice(i, i + CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const result = await db.prepare(
      `SELECT username_id, tag FROM username_tags WHERE username_id IN (${placeholders}) ORDER BY tag`
    ).bind(...chunk).all<{ username_id: number; tag: string }>()
    for (const row of result.results) {
      if (!map.has(row.username_id)) map.set(row.username_id, [])
      map.get(row.username_id)!.push(row.tag)
    }
  }
  return map
}

export async function getAllTags(
  db: D1Database
): Promise<{ tag: string; count: number }[]> {
  const result = await db.prepare(
    'SELECT tag, COUNT(*) as count FROM username_tags GROUP BY tag ORDER BY tag'
  ).bind().all<{ tag: string; count: number }>()
  return result.results
}

// --- Stats ---

export interface UsernameStats {
  totals: {
    all: number
    active: number
    reserved: number
    revoked: number
    burned: number
    pending_confirmation: number
    pending_release: number
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

export async function getUsernameStats(db: D1Database): Promise<UsernameStats> {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 24 * 60 * 60
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60

  const [summary, topTagsResult] = await Promise.all([
    db.prepare(
      `SELECT
         COUNT(*) AS all_count,
         SUM(CASE WHEN u.status = 'active' THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN u.status = 'reserved' THEN 1 ELSE 0 END) AS reserved_count,
         SUM(CASE WHEN u.status = 'revoked' THEN 1 ELSE 0 END) AS revoked_count,
         SUM(CASE WHEN u.status = 'burned' THEN 1 ELSE 0 END) AS burned_count,
         SUM(CASE WHEN u.status = 'pending-confirmation' THEN 1 ELSE 0 END) AS pending_confirmation_count,
         SUM(CASE WHEN u.status = 'pending-release' THEN 1 ELSE 0 END) AS pending_release_count,
         SUM(CASE WHEN u.admin_notes IS NOT NULL AND TRIM(u.admin_notes) != '' THEN 1 ELSE 0 END) AS with_notes_count,
         SUM(CASE WHEN tagged.username_id IS NOT NULL THEN 1 ELSE 0 END) AS with_tags_count,
         SUM(CASE WHEN tagged.username_id IS NULL THEN 1 ELSE 0 END) AS untagged_count,
         SUM(CASE WHEN vip.username_id IS NOT NULL THEN 1 ELSE 0 END) AS vip_count,
         SUM(CASE WHEN u.claimed_at IS NOT NULL AND u.claimed_at >= ? THEN 1 ELSE 0 END) AS claimed_7d_count,
         SUM(CASE WHEN u.claimed_at IS NOT NULL AND u.claimed_at >= ? THEN 1 ELSE 0 END) AS claimed_30d_count,
         SUM(CASE WHEN u.updated_at >= ? THEN 1 ELSE 0 END) AS updated_7d_count,
         SUM(CASE WHEN u.updated_at >= ? THEN 1 ELSE 0 END) AS updated_30d_count
       FROM usernames u
       LEFT JOIN (
         SELECT DISTINCT username_id FROM username_tags
       ) tagged ON tagged.username_id = u.id
       LEFT JOIN (
         SELECT DISTINCT username_id FROM username_tags WHERE tag = 'vip'
       ) vip ON vip.username_id = u.id`
    ).bind(sevenDaysAgo, thirtyDaysAgo, sevenDaysAgo, thirtyDaysAgo).first<{
      all_count: number
      active_count: number
      reserved_count: number
      revoked_count: number
      burned_count: number
      pending_confirmation_count: number
      pending_release_count: number
      with_notes_count: number
      with_tags_count: number
      untagged_count: number
      vip_count: number
      claimed_7d_count: number
      claimed_30d_count: number
      updated_7d_count: number
      updated_30d_count: number
    }>(),
    db.prepare(
      'SELECT tag, COUNT(*) AS count FROM username_tags GROUP BY tag ORDER BY count DESC, tag ASC LIMIT 10'
    ).bind().all<{ tag: string; count: number }>(),
  ])

  const stats = summary || {
    all_count: 0,
    active_count: 0,
    reserved_count: 0,
    revoked_count: 0,
    burned_count: 0,
    pending_confirmation_count: 0,
    pending_release_count: 0,
    with_notes_count: 0,
    with_tags_count: 0,
    untagged_count: 0,
    vip_count: 0,
    claimed_7d_count: 0,
    claimed_30d_count: 0,
    updated_7d_count: 0,
    updated_30d_count: 0,
  }

  return {
    totals: {
      all: stats.all_count,
      active: stats.active_count,
      reserved: stats.reserved_count,
      revoked: stats.revoked_count,
      burned: stats.burned_count,
      pending_confirmation: stats.pending_confirmation_count,
      pending_release: stats.pending_release_count,
    },
    metadata: {
      with_notes: stats.with_notes_count,
      with_tags: stats.with_tags_count,
      untagged: stats.untagged_count,
      vip: stats.vip_count,
    },
    activity: {
      claimed_7d: stats.claimed_7d_count,
      claimed_30d: stats.claimed_30d_count,
      updated_7d: stats.updated_7d_count,
      updated_30d: stats.updated_30d_count,
    },
    top_tags: topTagsResult.results,
  }
}

// --- Admin notes ---

export async function updateAdminNotes(
  db: D1Database,
  name: string,
  adminNotes: string | null,
  updatedBy: string | null
): Promise<Pick<Username, 'admin_notes' | 'admin_notes_updated_by' | 'admin_notes_updated_at'> | null> {
  const username = await getUsernameByName(db, name)
  if (!username) return null

  const now = Math.floor(Date.now() / 1000)
  await db.prepare(
    'UPDATE usernames SET admin_notes = ?, admin_notes_updated_by = ?, admin_notes_updated_at = ?, updated_at = ? WHERE id = ?'
  ).bind(adminNotes, updatedBy, now, now, username.id).run()

  return {
    admin_notes: adminNotes,
    admin_notes_updated_by: updatedBy,
    admin_notes_updated_at: now,
  }
}
