import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import internalImport from './internal-import'
import { finalizeReleaseAttempt, prepareReleaseAttempt } from '../db/queries'
import { createSqliteD1, seedUsername, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'
import { reconcileUsernameFastly } from '../utils/username-fastly-reconcile'

vi.mock('../utils/username-fastly-reconcile', () => ({ reconcileUsernameFastly: vi.fn().mockResolvedValue(undefined) }))

describe.skipIf(!sqliteAvailable())('ownership-checked import', () => {
  let db: D1Database
  let sqlite: SqliteDb
  const pubkey = 'a'.repeat(64)
  beforeEach(() => {
    ;({ db, sqlite } = createSqliteD1())
    vi.clearAllMocks()
  })
  afterEach(() => sqlite.close())
  function request(body: unknown, token: string | null = 'import-test', configured = true) {
    return internalImport.request('/username/import', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
    }, { DB: db, USERNAME_IMPORT_TOKEN: configured ? 'import-test' : undefined })
  }
  it('requires its dedicated service credential', async () => {
    expect((await request({ name: 'alice', pubkey }, null)).status).toBe(401)
    expect((await request({ name: 'alice', pubkey }, 'atproto-test')).status).toBe(401)
    expect((await request({ name: 'alice', pubkey }, 'import-test', false)).status).toBe(503)
    expect(sqlite.prepare('SELECT * FROM usernames').all()).toHaveLength(0)
  })
  it('inserts canonical provenance once and never re-syncs a skipped assignment', async () => {
    expect((await request({ name: 'Alice', pubkey })).status).toBe(201)
    expect(sqlite.prepare('SELECT name, claim_source, pubkey FROM usernames').get()).toEqual({ name: 'alice', claim_source: 'vine-import', pubkey })
    expect(reconcileUsernameFastly).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), 'alice')
    expect((await request({ name: 'ALICE', pubkey: 'b'.repeat(64) })).status).toBe(409)
    expect((await request({ name: 'alice', pubkey })).status).toBe(409)
    expect(reconcileUsernameFastly).toHaveBeenCalledTimes(1)
  })
  // The importer sends the creator's own casing and relies on this: the name is
  // shown as sent (profile pages, the by-pubkey lookup) and only the canonical
  // form is lowercased.
  it('stores the name as sent for display and lowercases only the canonical form', async () => {
    expect((await request({ name: 'JaneDoe', pubkey })).status).toBe(201)
    expect(sqlite.prepare('SELECT name, username_display, username_canonical FROM usernames').get())
      .toEqual({ name: 'janedoe', username_display: 'JaneDoe', username_canonical: 'janedoe' })
  })
  // The row is committed before the sync runs. Answering 500 would make the
  // caller stop, and its retry could only replay as a 409 conflict.
  it('still answers 201 when syncing the committed name to Fastly fails', async () => {
    vi.mocked(reconcileUsernameFastly).mockRejectedValueOnce(new Error('D1 unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await request({ name: 'alice', pubkey })).status).toBe(201)
    expect(sqlite.prepare('SELECT name, status FROM usernames').all()).toEqual([{ name: 'alice', status: 'active' }])
    expect(log).toHaveBeenCalledWith('Username import KV sync deferred for alice:', 'D1 unavailable')
    log.mockRestore()
  })
  it.each(['active', 'reserved', 'held', 'burned', 'revoked', 'pending-release'])('cannot replace %s ownership', async status => {
    seedUsername(sqlite, { name: 'alice', pubkey: 'b'.repeat(64), status })
    expect((await request({ name: 'alice', pubkey })).status).toBe(409)
    expect(sqlite.prepare('SELECT status, pubkey FROM usernames').get()).toEqual({ status, pubkey: 'b'.repeat(64) })
    expect(reconcileUsernameFastly).not.toHaveBeenCalled()
  })
  // Finalizing a deletion clears the released row's pubkey, so the one-owned-name
  // index no longer sees it. The import has no consent to rebuild a public
  // identity the deletion removed, so the attempt ledger has to stop it.
  it('does not recreate a public name for a pubkey whose owner deleted their account', async () => {
    seedUsername(sqlite, { name: 'cool_dude', pubkey })
    const attemptId = 'delete-attempt-00000001'
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    expect((await prepareReleaseAttempt(db, pubkey, 'cool_dude', attemptId, expiresAt)).outcome).toBe('transitioned')
    expect((await finalizeReleaseAttempt(db, attemptId, 'deletion-coordinator')).outcome).toBe('transitioned')
    expect(sqlite.prepare('SELECT status, pubkey FROM usernames').get()).toEqual({ status: 'held', pubkey: null })

    expect((await request({ name: 'cool-dude', pubkey })).status).toBe(409)
    expect((await request({ name: 'cool-dude', pubkey: pubkey.toUpperCase() })).status).toBe(409)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM usernames WHERE status = 'active'").get()).toEqual({ n: 0 })
    expect(reconcileUsernameFastly).not.toHaveBeenCalled()

    // Another pubkey importing the same name is unaffected.
    expect((await request({ name: 'cool-dude', pubkey: 'b'.repeat(64) })).status).toBe(201)
  })
  it('preserves the one-owned-name-per-pubkey constraint and reserved words', async () => {
    seedUsername(sqlite, { name: 'alice', pubkey })
    expect((await request({ name: 'bob', pubkey: pubkey.toUpperCase() })).status).toBe(409)
    expect((await request({ name: 'admin', pubkey: 'b'.repeat(64) })).status).toBe(409)
    expect(reconcileUsernameFastly).not.toHaveBeenCalled()
  })
  it.each([
    ['a name with a dot', { name: 'a.b', pubkey }],
    ['a malformed pubkey', { name: 'alice', pubkey: 'bad' }],
    ['relays that are not a list', { name: 'alice', pubkey, relays: 'bad' }],
  ])('rejects invalid input: %s', async (_label, body) => {
    expect((await request(body)).status).toBe(400)
    expect(reconcileUsernameFastly).not.toHaveBeenCalled()
  })
})
