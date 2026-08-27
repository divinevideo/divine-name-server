// ABOUTME: Admin force-release of a held name and release-history lookup.
import { describe, expect, it } from 'vitest'
import { releaseHeldNameEarly, getUsernameReleaseHistory, getUsernameByName } from '../db/queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('admin hold operability', () => {
  it('force-releases a held name to a claimable revoked row', async () => {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })

    expect(await releaseHeldNameEarly(db, 'alice', 500)).toBe(1)
    const row = await getUsernameByName(db, 'alice')
    expect(row?.status).toBe('revoked')
    expect(row?.recyclable).toBe(1)

    expect(await releaseHeldNameEarly(db, 'alice', 500)).toBe(0) // no longer held
  })

  it('reads release history newest-first', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(`INSERT INTO username_release_history (username_canonical, released_at, reason) VALUES ('alice', 100, 'deletion'), ('alice', 200, 'deletion')`).run()
    const history = await getUsernameReleaseHistory(db, 'alice')
    expect(history.map((h) => h.released_at)).toEqual([200, 100])
  })
})
