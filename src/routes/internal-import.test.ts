import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import internalImport from './internal-import'
import { finalizeReleaseAttempt, prepareReleaseAttempt } from '../db/queries'
import { createSqliteD1, seedUsername, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'
import { reconcileUsernameFastly } from '../utils/username-fastly-reconcile'
import { putBlockVerdict } from '../db/block-verdicts'
import { JUDGMENT_POLICY } from '../utils/judgment'
import type { BlockEnv } from '../utils/name-block'

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
  function request(body: unknown, token: string | null = 'import-test', configured = true, env: BlockEnv = {}, database: D1Database = db) {
    return internalImport.request('/username/import', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
    }, { DB: database, USERNAME_IMPORT_TOKEN: configured ? 'import-test' : undefined, ...env })
  }
  function importAs(name: string, env: BlockEnv = {}) {
    return request({ name, pubkey }, 'import-test', true, env)
  }
  function reserve(word: string, scope: 'whole' | 'token', category = 'slur') {
    sqlite.prepare('INSERT INTO reserved_words (word, category, created_at, match_scope) VALUES (?, ?, 1, ?)').run(word, category, scope)
  }
  function judgment() {
    const run = vi.fn(async () => ({ model: 'clef', answers: { meant: { type: 'noul', noul: 0.9 } } }))
    return { AI: { run }, JUDGMENT_BLOCK_MIN: '0.5', run }
  }
  const rowCount = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM usernames').get() as { n: number }).n

  // The import has to refuse whatever a self-service claim refuses as reserved,
  // without spending the judgment budget that live sign-ups share.
  describe('reserved-word rules', () => {
    it('refuses a token-scoped term inside a longer name', async () => {
      reserve('zxqword', 'token')
      const res = await importAs('aa-zxqword')
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'reserved' })
      expect(rowCount()).toBe(0)
      expect(reconcileUsernameFastly).not.toHaveBeenCalled()
    })
    it('refuses a digit-for-letter respelling of a reserved word', async () => {
      reserve('zxqword', 'whole')
      const res = await importAs('zxqw0rd')
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'reserved' })
      expect(rowCount()).toBe(0)
    })
    it('refuses an exact reserved match', async () => {
      const res = await importAs('admin')
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'reserved' })
      expect(rowCount()).toBe(0)
    })
    it('refuses an ambiguous name it cannot confirm clear, without calling the judgment model', async () => {
      reserve('zxqword', 'token')
      const { run, ...env } = judgment()
      const res = await importAs('zxqwordextra', env)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'unavailable' })
      expect(run).not.toHaveBeenCalled()
      expect(rowCount()).toBe(0)
    })
    it('follows a cached verdict for an ambiguous name', async () => {
      reserve('zxqword', 'token')
      const { run, ...env } = judgment()
      await putBlockVerdict(db, 'zxqwordextra', 1, `${JUDGMENT_POLICY}:0.5`, 'blocked', 1, 0.9)
      await putBlockVerdict(db, 'zxqwordother', 1, `${JUDGMENT_POLICY}:0.5`, 'clear', 1, 0.1)
      const blocked = await importAs('zxqwordextra', env)
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toMatchObject({ ok: false, code: 'reserved' })
      expect((await importAs('zxqwordother', env)).status).toBe(201)
      expect(run).not.toHaveBeenCalled()
    })
    // Same as claims: with no judgment configured, only scoped hits block.
    it('imports an ambiguous name when judgment is not configured', async () => {
      reserve('zxqword', 'token')
      expect((await importAs('zxqwordextra')).status).toBe(201)
    })
    it('imports a clean name unchanged', async () => {
      reserve('zxqword', 'token')
      const { run, ...env } = judgment()
      const res = await importAs('plainname', env)
      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ ok: true, name: 'plainname', claim_source: 'vine-import' })
      expect(run).not.toHaveBeenCalled()
    })
    // A term added after classification read the list is still caught by the
    // insert's own exact-match guard, and is still reported as reserved.
    it('reports reserved when the insert guard catches a term added mid-request', async () => {
      const racing: D1Database = Object.create(db)
      racing.prepare = (sql: string) => {
        if (sql.includes('INSERT INTO usernames')) reserve('zxqracer', 'whole')
        return db.prepare(sql)
      }
      // Mixed case: the lookup has to use the canonical form, not the display.
      const res = await request({ name: 'ZxqRacer', pubkey }, 'import-test', true, {}, racing)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'reserved' })
      expect(rowCount()).toBe(0)
    })
  })
  // Same rule as claims: blocking a name stops new people taking it, not the
  // active owner. Their replay is the ordinary replay refusal.
  describe('active owner replaying a name blocked since', () => {
    it('reports the replay as taken, not reserved', async () => {
      expect((await importAs('zxqword')).status).toBe(201)
      reserve('zxqword', 'whole')
      const res = await importAs('zxqword')
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'taken' })
    })
    it('reports taken where the check would answer unavailable', async () => {
      expect((await importAs('zxqwordextra')).status).toBe(201)
      reserve('zxqword', 'token')
      const { run: _run, ...env } = judgment()
      const res = await importAs('zxqwordextra', env)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'taken' })
    })
    // A seeded row, not one this import created: any claim source, a stored
    // pubkey in another case, and no blocklist read at all on the exempt path.
    it('exempts an owner row from any source without reading the blocklist', async () => {
      seedUsername(sqlite, { name: 'aa-zxqword', pubkey: pubkey.toUpperCase() })
      reserve('zxqword', 'token')
      const guarded: D1Database = Object.create(db)
      guarded.prepare = (sql: string) => {
        if (sql.includes('blocklist_meta') || sql.includes('FROM reserved_words')) throw new Error('blocklist read on exempt path')
        return db.prepare(sql)
      }
      const res = await request({ name: 'aa-zxqword', pubkey }, 'import-test', true, {}, guarded)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'taken' })
    })
    it('still reports reserved to another pubkey', async () => {
      expect((await importAs('zxqword')).status).toBe(201)
      reserve('zxqword', 'whole')
      const res = await request({ name: 'zxqword', pubkey: 'b'.repeat(64) })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'reserved' })
    })
    // A token term, so the insert's exact-match lookup cannot answer reserved
    // on the classification's behalf.
    it('does not exempt the same pubkey on a row that is no longer active', async () => {
      seedUsername(sqlite, { name: 'aa-zxqword', pubkey, status: 'revoked' })
      reserve('zxqword', 'token')
      const res = await importAs('aa-zxqword')
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'reserved' })
    })
  })
  it('reports a name held by another pubkey as taken', async () => {
    seedUsername(sqlite, { name: 'alice', pubkey: 'b'.repeat(64) })
    const res = await importAs('alice')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, code: 'taken' })
  })
  // The importer's replay of a name the pubkey already holds is not told apart
  // from a name someone else holds.
  it('reports a replay of the same pubkey and name as taken', async () => {
    expect((await importAs('alice')).status).toBe(201)
    const res = await importAs('alice')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, code: 'taken' })
  })
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
    const res = await request({ name: 'alice', pubkey })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, code: 'taken' })
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

    const refused = await request({ name: 'cool-dude', pubkey })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ ok: false, code: 'taken' })
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
