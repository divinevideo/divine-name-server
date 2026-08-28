// ABOUTME: Runs the release-attempt state machine against the real migrated schema.
// ABOUTME: Covers the partial unique indexes and cross-statement predicates a fake cannot.

import { describe, expect, it } from 'vitest'
import {
  finalizeReleaseAttempt,
  getReleaseAttemptById,
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

    expect((await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT)).outcome).toBe('replayed')
  })

  it('treats an expiry restoration as an idempotent rollback success', async () => {
    const { db } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 200, 100)
    await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 'expired-restored', 200)

    const replay = await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 'cancelled', 201)

    expect(replay.outcome).toBe('replayed')
    if (replay.outcome !== 'replayed') throw new Error('Expected an idempotent expiry restoration replay')
    expect(replay.attempt?.state).toBe('expired-restored')
    expect(replay.username).toMatchObject({ status: 'active', pubkey: OWNER })
  })

  it('does not replay a restored attempt when the username belongs to another pubkey', async () => {
    const { db, sqlite } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 200, 100)
    await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 'expired-restored', 200)
    sqlite.prepare('UPDATE usernames SET pubkey = ? WHERE username_canonical = ?').run(OTHER, 'alice')

    const replay = await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 'cancelled', 201)

    expect(replay.outcome).toBe('conflict')
  })

  it('does not finish a pending attempt against another pubkey active row', async () => {
    const { db, sqlite } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)
    sqlite.prepare("UPDATE usernames SET status = 'active', pubkey = ? WHERE username_canonical = ?").run(OTHER, 'alice')

    const result = await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 'cancelled', 201)

    expect(result.outcome).toBe('conflict')
    expect((await getReleaseAttemptById(db, ATTEMPT))?.state).toBe('pending')
  })

  it('finalizes to a one-year hold, clears pubkey, and writes one breadcrumb', async () => {
    const { db, sqlite } = withOwnedName()
    sqlite.prepare(
      `UPDATE usernames
       SET relays = '["wss://old-owner.example"]', atproto_did = 'did:plc:old-owner', atproto_state = 'ready'
       WHERE username_canonical = 'alice'`
    ).run()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)).outcome).toBe('transitioned')
    const held = await getUsernameByName(db, 'alice')
    expect(held?.status).toBe('held')
    expect(held?.recyclable).toBe(0)
    expect(held?.pubkey).toBeNull()
    expect(held?.relays).toBeNull()
    expect(held?.atproto_did).toBeNull()
    expect(held?.atproto_state).toBeNull()
    expect(held?.revoked_at).toBe(200)

    const history = sqlite
      .prepare('SELECT username_canonical, released_at, reason FROM username_release_history WHERE username_canonical = ?')
      .all('alice')
    expect(history).toEqual([{ username_canonical: 'alice', released_at: 200, reason: 'deletion' }])

    // A finalized attempt is terminal and cannot be rolled back.
    expect((await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT)).outcome).toBe('conflict')
  })

  it('replays finalize idempotently without a second breadcrumb', async () => {
    const { db, sqlite } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)
    await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 201)).outcome).toBe('replayed')
    const count = sqlite
      .prepare('SELECT COUNT(*) AS n FROM username_release_history WHERE username_canonical = ?')
      .get('alice') as { n: number }
    expect(count.n).toBe(1)
  })

  it('returns a reserved-origin name to the reserve with no hold or breadcrumb', async () => {
    const { db, sqlite } = withOwnedName()
    sqlite.prepare(`INSERT INTO reserved_words (word, category, reason, created_at) VALUES ('alice', 'brand', 'test', 100)`).run()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)).outcome).toBe('transitioned')
    const reserved = await getUsernameByName(db, 'alice')
    expect(reserved?.status).toBe('reserved')
    expect(reserved?.pubkey).toBeNull()

    const count = sqlite
      .prepare('SELECT COUNT(*) AS n FROM username_release_history WHERE username_canonical = ?')
      .get('alice') as { n: number }
    expect(count.n).toBe(0)
  })

  it('does not finalize after the recovery deadline', async () => {
    const { db } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 200, 100)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)).outcome).toBe('conflict')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('pending-release')
  })

  it('rejects a non-owner rollback and a second pending attempt', async () => {
    const { db } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await rollbackReleaseAttempt(db, OTHER, 'alice', ATTEMPT)).outcome).toBe('conflict')
    expect((await prepareReleaseAttempt(db, OWNER, 'alice', 'delete-attempt-00000002', 999, 100)).outcome).toBe('conflict')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('pending-release')
  })

  it('reports the pending attempt when a cancelled one shares its timestamp', async () => {
    const { db } = withOwnedName()
    // created_at is whole seconds, so a cancel-and-retry inside one second
    // leaves two attempts with the same value. Attempt ids are opaque and
    // client-chosen, so the cancelled one can sort after the live one.
    const cancelled = 'delete-attempt-zzzzzzzz'
    const pending = 'delete-attempt-aaaaaaaa'

    await prepareReleaseAttempt(db, OWNER, 'alice', cancelled, 999, 100)
    await rollbackReleaseAttempt(db, OWNER, 'alice', cancelled, 'cancelled', 100)
    expect((await prepareReleaseAttempt(db, OWNER, 'alice', pending, 999, 100)).outcome).toBe('transitioned')

    // /claim gates on this lookup reporting 'pending'. If it returns the
    // cancelled attempt instead, the claim proceeds and collides with the
    // pending-release row on idx_usernames_pubkey_owned.
    const latest = await getLatestReleaseAttemptByPubkey(db, OWNER)
    expect(latest?.attempt_id).toBe(pending)
    expect(latest?.state).toBe('pending')
  })

  it('leaves the name untouched when the caller does not own it', async () => {
    const { db } = withOwnedName()
    const result = await prepareReleaseAttempt(db, OTHER, 'alice', ATTEMPT, 999, 100)

    expect(result.outcome).toBe('not_found')
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('active')
    expect(await getLatestReleaseAttemptByPubkey(db, OTHER)).toBeNull()
  })
})
