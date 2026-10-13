import { describe, expect, it } from 'vitest'
import { getUsernameByName, getUsernameSyncStates } from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('queue state bulk lookup', () => {
  it('reads a full 5000-name queue page in one statement without exceeding the parameter limit', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      const names = Array.from({ length: 5000 }, (_, i) => `name-${i}`)
      for (const name of names) seedUsername(sqlite, { name, status: 'reserved' })
      let statements = 0
      const prepare = db.prepare.bind(db)
      db.prepare = sql => { statements++; return prepare(sql) }
      const states = await getUsernameSyncStates(db, names)
      expect(states.size).toBe(5000)
      expect(states.get('name-4999')?.status).toBe('reserved')
      expect(statements).toBe(1)
    } finally { sqlite.close() }
  })
  it('matches single-name lookup for current, inactive, legacy and absent names', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'alice', pubkey: 'a'.repeat(64) })
      seedUsername(sqlite, { name: 'legacy_name', status: 'held' })
      seedUsername(sqlite, { name: 'empty', status: 'reserved' })
      const names = ['alice', 'ALICE', 'legacy_name', 'empty', 'absent']
      const states = await getUsernameSyncStates(db, names)
      for (const name of names) {
        const row = await getUsernameByName(db, name)
        expect(states.get(name)).toEqual(row ? {
          pubkey: row.pubkey, relays: row.relays, status: row.status, atproto_did: row.atproto_did, atproto_state: row.atproto_state,
        } : null)
      }
      expect(await getUsernameSyncStates(db, [])).toEqual(new Map())
    } finally { sqlite.close() }
  })
})
