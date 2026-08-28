// ABOUTME: The cron sweep returns one-year-old holds to the claimable revoked state.
import { describe, expect, it } from 'vitest'
import { expireHolds, RELEASE_HOLD_SECONDS, getUsernameByName } from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('expireHolds', () => {
  const NOW = 1_000_000_000

  function heldSince(revokedAt: number) {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })
    sqlite.prepare('UPDATE usernames SET revoked_at = ? WHERE username_canonical = ?').run(revokedAt, 'alice')
    return { db }
  }

  it('leaves a hold that is one day short of a year untouched', async () => {
    const { db } = heldSince(NOW - RELEASE_HOLD_SECONDS + 86_400)
    expect(await expireHolds(db, NOW)).toBe(0)
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('held')
  })

  it('returns a hold past one year to a claimable revoked row', async () => {
    const { db } = heldSince(NOW - RELEASE_HOLD_SECONDS - 86_400)
    expect(await expireHolds(db, NOW)).toBe(1)
    const cleared = await getUsernameByName(db, 'alice')
    expect(cleared?.status).toBe('revoked')
    expect(cleared?.recyclable).toBe(1)
  })
})
