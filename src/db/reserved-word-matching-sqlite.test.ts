// ABOUTME: Runs isReservedWord against the real migration chain, so the matching
// ABOUTME: rules are exercised through the columns 0015 actually creates.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sqliteAvailable, createSqlite, applyMigrations, asD1, type SqliteDb } from './sqlite-test-helpers'
import { addReservedWord, isReservedWord, reservedWordsMatching } from './queries'

const describeSqlite = sqliteAvailable() ? describe : describe.skip

describeSqlite('isReservedWord with per-term rules', () => {
  let sqlite: SqliteDb
  let db: D1Database

  function reserve(word: string, over: Record<string, string | number> = {}) {
    const cols = { match_scope: 'whole', match_leet: 1, match_digit_expand: 0, match_repeats: 0, ...over }
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope, match_leet, match_digit_expand, match_repeats)
       VALUES (?, 'test', NULL, 0, ?, ?, ?, ?)
       ON CONFLICT(word) DO UPDATE SET match_scope = excluded.match_scope,
         match_leet = excluded.match_leet, match_digit_expand = excluded.match_digit_expand,
         match_repeats = excluded.match_repeats`
    ).run(word, cols.match_scope, cols.match_leet, cols.match_digit_expand, cols.match_repeats)
  }

  beforeEach(() => {
    sqlite = createSqlite()
    applyMigrations(sqlite)
    sqlite.exec('DELETE FROM reserved_words')
    db = asD1(sqlite)
  })

  afterEach(() => sqlite.close())

  it('blocks the exact word, as before', async () => {
    reserve('admin')
    expect(await isReservedWord(db, 'admin')).toBe(true)
    expect(await isReservedWord(db, 'unrelated')).toBe(false)
  })

  it('closes the reported bug: separators inside a reserved word', async () => {
    reserve('admin')
    expect(await isReservedWord(db, 'ad-min')).toBe(true)
    expect(await isReservedWord(db, 'a-d-m-i-n')).toBe(true)
  })

  it('leaves a word at default scope alone inside a longer name', async () => {
    // The safe default. `badminton` must stay registerable.
    reserve('admin')
    expect(await isReservedWord(db, 'myadmin')).toBe(false)
    expect(await isReservedWord(db, 'badminton')).toBe(false)
  })

  it('honours token scope', async () => {
    reserve('admin', { match_scope: 'token' })
    expect(await isReservedWord(db, 'xx-admin-xx')).toBe(true)
    expect(await isReservedWord(db, 'badminton')).toBe(false)
  })

  it('honours anywhere scope', async () => {
    reserve('admin', { match_scope: 'anywhere' })
    expect(await isReservedWord(db, 'myadmin')).toBe(true)
  })

  it('reads a leetspelled term back to its plain spelling only when told to', async () => {
    reserve('h1tler', { match_scope: 'anywhere' })
    expect(await isReservedWord(db, 'zzz-hitler')).toBe(false)

    reserve('h1tler', { match_scope: 'anywhere', match_digit_expand: 1 })
    expect(await isReservedWord(db, 'zzz-hitler')).toBe(true)
  })

  it('does not block an ordinary name that merely contains a term', async () => {
    // At `anywhere`, `anal` takes every name where "an" meets "al", a large
    // group of transliterated Arabic and Spanish given names, plus canal,
    // analysis and analogue. At `token` it takes none of them.
    reserve('anal', { match_scope: 'token' })
    for (const name of ['hassan-alvarez', 'joanna-lisbon', 'brian-alexander', 'canal-street']) {
      expect(await isReservedWord(db, name), name).toBe(false)
    }
  })

  it('a term with no rules set behaves as whole scope', async () => {
    // Rows written before 0015 take the column defaults.
    sqlite.prepare(
      "INSERT INTO reserved_words (word, category, reason, created_at) VALUES ('legacy', 'test', NULL, 0)"
    ).run()
    expect(await isReservedWord(db, 'legacy')).toBe(true)
    expect(await isReservedWord(db, 'mylegacy')).toBe(false)
  })

  it('an unrecognised scope value falls back to whole rather than opening up', async () => {
    reserve('admin', { match_scope: 'nonsense' })
    expect(await isReservedWord(db, 'admin')).toBe(true)
    expect(await isReservedWord(db, 'myadmin')).toBe(false)
  })

  it('reports which words matched, for explaining a rejection', async () => {
    reserve('admin')
    reserve('min', { match_scope: 'anywhere' })
    expect((await reservedWordsMatching(db, 'ad-min')).sort()).toEqual(['admin', 'min'])
    expect(await reservedWordsMatching(db, 'unrelated')).toEqual([])
  })

  it('keeps the stored scope when a word is re-added without one', async () => {
    reserve('admin', { match_scope: 'token' })
    expect(await addReservedWord(db, 'admin', 'system', 'new reason')).toBe('token')
    expect(await isReservedWord(db, 'my-admin')).toBe(true)

    expect(await addReservedWord(db, 'admin', 'system', null, 'whole')).toBe('whole')
    expect(await isReservedWord(db, 'my-admin')).toBe(false)

    expect(await addReservedWord(db, 'fresh', 'system', null)).toBe('whole')
  })

  it('picks up a moderator edit without a restart', async () => {
    reserve('admin')
    expect(await isReservedWord(db, 'myadmin')).toBe(false)
    reserve('admin', { match_scope: 'anywhere' })
    expect(await isReservedWord(db, 'myadmin')).toBe(true)
  })
})

describeSqlite('migration 0015', () => {
  let sqlite: SqliteDb

  beforeEach(() => {
    sqlite = createSqlite()
    applyMigrations(sqlite)
  })
  afterEach(() => sqlite.close())

  it('defaults every pre-existing word to whole scope', async () => {
    const row = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM reserved_words WHERE match_scope NOT IN ('whole','token','anywhere')"
    ).get() as { n: number }
    expect(row.n).toBe(0)
  })

  it('applies its per-word tuning on a database built from the repo', async () => {
    // The tuned words were first loaded outside the repo. If the migration only
    // updated them, a fresh database would have no rows and no tuning.
    const rows = sqlite.prepare(
      "SELECT word, match_scope, match_digit_expand FROM reserved_words WHERE word IN ('pussy','nazi','h1tler')"
    ).all() as Array<{ word: string; match_scope: string; match_digit_expand: number }>
    const byWord = Object.fromEntries(rows.map((row) => [row.word, row]))
    expect(byWord.pussy?.match_scope).toBe('anywhere')
    expect(byWord.nazi?.match_scope).toBe('token')
    expect(byWord.h1tler?.match_digit_expand).toBe(1)

    const db = asD1(sqlite)
    expect(await isReservedWord(db, 'xx-nazi-xx')).toBe(true)
    expect(await isReservedWord(db, 'hitler')).toBe(true)
  })

  it('does not loosen a word that only ever collides', async () => {
    // `sa` and `ss` catch nothing and collide with 51 registered people between
    // them. They must stay inert.
    const rows = sqlite.prepare(
      "SELECT word, match_scope FROM reserved_words WHERE word IN ('sa','ss','orion')"
    ).all() as Array<{ word: string; match_scope: string }>
    for (const row of rows) expect(row.match_scope, row.word).toBe('whole')
  })
})
