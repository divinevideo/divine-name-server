// ABOUTME: Verifies the migration chain applies cleanly and fails safely.
// ABOUTME: The one-owned-name-per-pubkey guard must never be dropped without a replacement.

import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  createSqlite,
  createSqliteD1,
  migrationSql,
  pubkeyIndexNames,
  sqliteAvailable,
} from './sqlite-test-helpers'

const RELEASE_MIGRATION = '0012_add_release_attempts'

describe.skipIf(!sqliteAvailable())('migration chain', () => {
  it('applies cleanly and leaves exactly one owned-name guard', () => {
    const { sqlite } = createSqliteD1()
    expect(pubkeyIndexNames(sqlite)).toEqual(['idx_usernames_pubkey_owned'])
  })

  it('keeps a uniqueness guard when legacy rows collide only by pubkey case', () => {
    const sqlite = createSqlite()
    applyMigrations(sqlite, { stopBefore: RELEASE_MIGRATION })

    // The pre-0012 index keys on raw `pubkey`, so it permits two active rows
    // whose keys differ only in case. queries.ts notes legacy rows may hold
    // mixed-case hex pubkeys, so production can look like this.
    sqlite.exec(`
      INSERT INTO usernames (name, username_canonical, pubkey, status, recyclable, created_at, updated_at)
      VALUES ('bob','bob','ABCDEF','active',1,1,1), ('carol','carol','abcdef','active',1,1,1)
    `)

    // 0012 re-keys the index on LOWER(pubkey), which those rows violate. The
    // migration must fail with the old guard intact rather than dropping it
    // first and leaving the table with no uniqueness constraint at all.
    expect(() => sqlite.exec(migrationSql(RELEASE_MIGRATION))).toThrow(/UNIQUE constraint failed/)
    expect(pubkeyIndexNames(sqlite)).toEqual(['idx_usernames_pubkey_active'])
  })
})
