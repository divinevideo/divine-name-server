// ABOUTME: Stats include held names so per-status counts sum to the total.
import { describe, expect, it } from 'vitest'
import { getUsernameStats } from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('getUsernameStats held bucket', () => {
  it('counts held names and keeps per-status totals summing to all', async () => {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'A', canonical: 'a', pubkey: 'a'.repeat(64), status: 'active' })
    seedUsername(sqlite, { name: 'H', canonical: 'h', pubkey: null, status: 'held', recyclable: 0 })

    const stats = await getUsernameStats(db)
    expect(stats.totals.held).toBe(1)
    const t = stats.totals
    expect(t.active + t.reserved + t.revoked + t.burned + t.pending_confirmation + t.pending_release + t.held).toBe(t.all)
  })
})
