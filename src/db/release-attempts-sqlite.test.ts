// ABOUTME: Runs the release-attempt state machine against the real migrated schema.
// ABOUTME: Covers the partial unique indexes and cross-statement predicates a fake cannot.

import { describe, expect, it } from 'vitest'
import {
  finalizeReleaseAttempt,
  getLatestReleaseAttemptByPubkey,
  prepareReleaseAttempt,
  rollbackReleaseAttempt,
  getUsernameByName,
} from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

const OWNER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ATTEMPT = 'delete-attempt-00000001'

function withOwnedName() {
  const { db, sqlite } = createSqliteD1()
  seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: OWNER, status: 'active' })
  return { db, sqlite }
}

describe.skipIf(!sqliteAvailable())('release attempts against real SQLite', () => {
  it('prepares, replays, and rolls back the same row', async () => {
    const { db } = withOwnedName()

    const prepared = await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)
    expect(prepared.outcome).toBe('transitioned')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('pending-release')

    expect((await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)).outcome).toBe('replayed')

    const rolledBack = await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 'cancelled', 200)
    expect(rolledBack.outcome).toBe('transitioned')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('active')
  })

  it('finalizes to a non-recyclable burn that cannot be rolled back', async () => {
    const { db } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)).outcome).toBe('transitioned')
    const burned = await getUsernameByName(db, 'alice')
    expect(burned?.status).toBe('burned')
    expect(burned?.recyclable).toBe(0)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 201)).outcome).toBe('replayed')
    expect((await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT)).outcome).toBe('conflict')
  })

  it('rejects a non-owner rollback and a second pending attempt', async () => {
    const { db } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await rollbackReleaseAttempt(db, OTHER, 'alice', ATTEMPT)).outcome).toBe('conflict')
    expect((await prepareReleaseAttempt(db, OWNER, 'alice', 'delete-attempt-00000002', 999, 100)).outcome).toBe('conflict')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('pending-release')
  })

  it('leaves the name untouched when the caller does not own it', async () => {
    const { db } = withOwnedName()
    const result = await prepareReleaseAttempt(db, OTHER, 'alice', ATTEMPT, 999, 100)

    expect(result.outcome).toBe('not_found')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('active')
    expect(await getLatestReleaseAttemptByPubkey(db, OTHER)).toBeNull()
  })
})
