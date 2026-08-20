// ABOUTME: Exercises release-attempt database transitions as one transactional state machine.
// ABOUTME: Verifies ownership, idempotency, terminal exclusion, and exact-name restoration.

import { describe, expect, it } from 'vitest'
import { finalizeReleaseAttempt, prepareReleaseAttempt, rollbackReleaseAttempt, type UsernameReleaseAttempt } from './queries'

function createReleaseDB() {
  const username: any = {
    id: 1, name: 'Alice', username_display: 'Alice', username_canonical: 'alice', pubkey: 'a'.repeat(64),
    status: 'active', recyclable: 1, created_at: 1, updated_at: 1, revoked_at: null,
  }
  const attempts = new Map<string, UsernameReleaseAttempt>()
  const db = {
    prepare(sql: string) {
      let params: any[] = []
      return {
        bind(...values: any[]) {
          params = values
          return {
            first: async () => {
              if (sql.includes('WHERE attempt_id = ?')) return attempts.get(params[0]) || null
              if (sql.includes('FROM username_release_attempts') && sql.includes('LOWER(pubkey)')) {
                const matching = [...attempts.values()].filter(a => a.pubkey.toLowerCase() === params[0].toLowerCase())
                return matching[matching.length - 1] || null
              }
              if (sql.includes('FROM usernames')) return username.username_canonical === params[0] || username.name === params[1] ? username : null
              return null
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.includes('INSERT OR IGNORE INTO username_release_attempts')) {
                const [attemptId, createdAt, updatedAt, expiresAt, canonical, pubkey] = params
                const pendingForOwner = [...attempts.values()].some(a => a.pubkey.toLowerCase() === pubkey.toLowerCase() && a.state === 'pending')
                if (attempts.has(attemptId) || pendingForOwner || username.status !== 'active' || canonical !== username.username_canonical || pubkey.toLowerCase() !== username.pubkey.toLowerCase()) {
                  return { success: true, meta: { changes: 0 } }
                }
                attempts.set(attemptId, {
                  attempt_id: attemptId, username_canonical: canonical, pubkey: username.pubkey, state: 'pending',
                  created_at: createdAt, updated_at: updatedAt, expires_at: expiresAt,
                  cancelled_at: null, finalized_at: null, finalized_by: null,
                })
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.includes("SET status = 'pending-release'")) {
                const [updatedAt, canonical, pubkey, attemptId] = params
                const attempt = attempts.get(attemptId)
                if (username.status !== 'active' || canonical !== username.username_canonical || pubkey.toLowerCase() !== username.pubkey.toLowerCase() || attempt?.state !== 'pending') return { success: true, meta: { changes: 0 } }
                username.status = 'pending-release'; username.updated_at = updatedAt
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.includes("UPDATE usernames SET status = 'active'")) {
                const [updatedAt, canonical, pubkey, attemptId] = params
                const attempt = attempts.get(attemptId)
                if (username.status !== 'pending-release' || canonical !== username.username_canonical || pubkey.toLowerCase() !== username.pubkey.toLowerCase() || attempt?.state !== 'pending') return { success: true, meta: { changes: 0 } }
                username.status = 'active'; username.updated_at = updatedAt; username.revoked_at = null
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.includes('SET state = ?, updated_at')) {
                const [state, updatedAt, cancelledAt, attemptId] = params
                const attempt = attempts.get(attemptId)
                if (attempt?.state !== 'pending' || username.status !== 'active') return { success: true, meta: { changes: 0 } }
                attempt.state = state; attempt.updated_at = updatedAt; attempt.cancelled_at = cancelledAt
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.includes("SET status = 'burned'")) {
                const [revokedAt, updatedAt, canonical, pubkey, attemptId] = params
                const attempt = attempts.get(attemptId)
                if (username.status !== 'pending-release' || canonical !== username.username_canonical || pubkey.toLowerCase() !== username.pubkey.toLowerCase() || attempt?.state !== 'pending') return { success: true, meta: { changes: 0 } }
                username.status = 'burned'; username.recyclable = 0; username.revoked_at = revokedAt; username.updated_at = updatedAt
                return { success: true, meta: { changes: 1 } }
              }
              if (sql.includes("SET state = 'finalized'")) {
                const [updatedAt, finalizedAt, finalizedBy, attemptId] = params
                const attempt = attempts.get(attemptId)
                if (attempt?.state !== 'pending' || username.status !== 'burned') return { success: true, meta: { changes: 0 } }
                attempt.state = 'finalized'; attempt.updated_at = updatedAt; attempt.finalized_at = finalizedAt; attempt.finalized_by = finalizedBy
                return { success: true, meta: { changes: 1 } }
              }
              return { success: true, meta: { changes: 0 } }
            },
          }
        },
      }
    },
    batch: async (statements: Array<{ run: () => Promise<any> }>) => Promise.all(statements.map(statement => statement.run())),
  } as unknown as D1Database
  return { db, username, attempts }
}

describe('release-attempt database state machine', () => {
  it('prepares and idempotently restores the exact row', async () => {
    const { db, username } = createReleaseDB()
    const prepared = await prepareReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000001', 500, 100)
    expect(prepared.outcome).toBe('transitioned')
    expect(username.status).toBe('pending-release')
    const replay = await prepareReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000001', 500, 100)
    expect(replay.outcome).toBe('replayed')
    const rolledBack = await rollbackReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000001', 'cancelled', 200)
    expect(rolledBack.outcome).toBe('transitioned')
    expect(username).toMatchObject({ name: 'Alice', username_canonical: 'alice', status: 'active' })
    expect((await rollbackReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000001', 'cancelled', 201)).outcome).toBe('replayed')
  })

  it('allows exactly one terminal transition and makes finalization permanent', async () => {
    const { db, username } = createReleaseDB()
    await prepareReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000002', 500, 100)
    expect((await finalizeReleaseAttempt(db, 'delete-attempt-00000002', 'coordinator', 200)).outcome).toBe('transitioned')
    expect(username).toMatchObject({ status: 'burned', recyclable: 0 })
    expect((await finalizeReleaseAttempt(db, 'delete-attempt-00000002', 'coordinator', 201)).outcome).toBe('replayed')
    expect((await rollbackReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000002')).outcome).toBe('conflict')
  })

  it('rejects non-owners and a second pending attempt', async () => {
    const { db, username } = createReleaseDB()
    await prepareReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000003', 500, 100)
    expect((await rollbackReleaseAttempt(db, 'b'.repeat(64), 'alice', 'delete-attempt-00000003')).outcome).toBe('conflict')
    expect((await prepareReleaseAttempt(db, username.pubkey, 'alice', 'delete-attempt-00000004', 500, 100)).outcome).toBe('conflict')
  })
})
