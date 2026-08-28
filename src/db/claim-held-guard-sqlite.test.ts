// ABOUTME: Pins that a held name is un-claimable until its hold expires.
import { describe, expect, it } from 'vitest'
import { claimUsername, expireHolds, RELEASE_HOLD_SECONDS, getUsernameByName } from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

const CLAIMANT = 'c'.repeat(64)

describe.skipIf(!sqliteAvailable())('held names and claim', () => {
  it('rejects claiming a held name, then allows it once the hold expires', async () => {
    const NOW = 2_000_000_000
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })
    sqlite.prepare('UPDATE usernames SET revoked_at = ? WHERE username_canonical = ?')
      .run(NOW - RELEASE_HOLD_SECONDS - 1, 'alice')

    await expect(claimUsername(db, 'Alice', 'alice', CLAIMANT, null)).rejects.toThrow('USERNAME_NOT_CLAIMABLE')

    expect(await expireHolds(db, NOW)).toBe(1)
    await claimUsername(db, 'Alice', 'alice', CLAIMANT, null)
    const claimed = await getUsernameByName(db, 'alice')
    expect(claimed?.status).toBe('active')
    expect(claimed?.pubkey?.toLowerCase()).toBe(CLAIMANT)
  })
})
