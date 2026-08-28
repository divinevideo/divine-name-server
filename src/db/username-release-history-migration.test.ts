// ABOUTME: Verifies the deletion breadcrumb table exists after migrations.
import { describe, expect, it } from 'vitest'
import { createSqliteD1, sqliteAvailable } from './sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('username_release_history migration', () => {
  it('creates an append-only breadcrumb table with no pubkey column', () => {
    const { sqlite } = createSqliteD1()
    const columns = sqlite
      .prepare('PRAGMA table_info(username_release_history)')
      .all()
      .map((row) => (row as { name: string }).name)

    expect(columns).toEqual(
      expect.arrayContaining(['id', 'username_canonical', 'released_at', 'reason']),
    )
    expect(columns).not.toContain('pubkey')
  })
})
