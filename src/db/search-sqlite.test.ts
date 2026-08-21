// ABOUTME: Exercises admin search SQL against real SQLite rather than the D1 fake.
// ABOUTME: Verifies LIKE escaping and oversized-query fallbacks at the database boundary.

import { describe, expect, it } from 'vitest'
import { searchUsernames } from './queries'
import { createSqliteD1, sqliteAvailable } from './sqlite-test-helpers'

function seedSearchRow(
  sqlite: ReturnType<typeof createSqliteD1>['sqlite'],
  canonical: string,
  fields: { email?: string; adminNotes?: string }
) {
  sqlite.prepare(
    `INSERT INTO usernames (
       name, username_display, username_canonical, email, admin_notes,
       status, recyclable, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', 1, 100, 100)`
  ).run(canonical, canonical, canonical, fields.email ?? null, fields.adminNotes ?? null)
}

describe.skipIf(!sqliteAvailable())('admin search against real SQLite', () => {
  it('treats percent, underscore, and backslash as literal search text', async () => {
    const { db, sqlite } = createSqliteD1()
    seedSearchRow(sqlite, 'literal-underscore', { email: 'first_last@example.com' })
    seedSearchRow(sqlite, 'wildcard-lookalike', { email: 'firstXlast@example.com' })
    seedSearchRow(sqlite, 'literal-percent', { adminNotes: 'team%ops' })
    seedSearchRow(sqlite, 'literal-backslash', { adminNotes: String.raw`path\name` })

    expect((await searchUsernames(db, { query: 'first_last@example.com' })).results.map((row) => row.name))
      .toEqual(['literal-underscore'])
    expect((await searchUsernames(db, { query: 'team%ops' })).results.map((row) => row.name))
      .toEqual(['literal-percent'])
    expect((await searchUsernames(db, { query: String.raw`path\name` })).results.map((row) => row.name))
      .toEqual(['literal-backslash'])
  })

  it('exact-matches an email whose UTF-8 LIKE pattern exceeds the limit', async () => {
    const { db, sqlite } = createSqliteD1()
    const email = `${'account'.repeat(7)}@example.com`
    seedSearchRow(sqlite, 'long-email', { email })

    const result = await searchUsernames(db, { query: email })

    expect(result.results.map((row) => row.name)).toEqual(['long-email'])
    expect(result.pagination.total).toBe(1)
  })
})
