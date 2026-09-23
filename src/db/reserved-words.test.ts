// ABOUTME: Every reserved word must be a form a username claim can actually produce.
// ABOUTME: A word stored in display form sits in the table looking right and blocks nothing.

import { describe, expect, it } from 'vitest'
import { createSqliteD1, migrationFiles, migrationSql, sqliteAvailable } from './sqlite-test-helpers'
import { isReservedWord } from './queries'
import { validateUsername } from '../utils/validation'

/** Every word the migration chain leaves in the table. */
function reservedWords(): string[] {
  const { sqlite } = createSqliteD1()
  return sqlite
    .prepare('SELECT word FROM reserved_words ORDER BY word')
    .all()
    .map((row) => (row as { word: string }).word)
}

/** Punycode rows paired with the display form their trailing comment claims. */
function encodedRows(): { word: string; display: string | null }[] {
  const rows: { word: string; display: string | null }[] = []
  for (const file of migrationFiles()) {
    // Scan per line rather than anchoring the tuple at column 0: an indented
    // row is the same row, and a guard that silently stops covering one
    // because of how a later migration is formatted is not a guard.
    for (const line of migrationSql(file).split('\n')) {
      const comment = line.match(/--\s*(\S+)\s*$/)
      for (const match of line.matchAll(/\('(xn--[^']+)'/g)) {
        rows.push({ word: match[1], display: comment ? comment[1] : null })
      }
    }
  }
  return rows
}

/** Words a migration recategorizes in place, which it must also guarantee exist. */
function recategorizedWords(): string[] {
  const words: string[] = []
  for (const file of migrationFiles()) {
    const sql = migrationSql(file)
    // `WHERE word = 'x'` is the same statement as a one-element IN list and
    // fails the same way, so both spellings have to be read.
    const updates = sql.matchAll(
      /UPDATE\s+reserved_words[^;]*?WHERE\s+word\s*(?:IN\s*\(([^)]*)\)|=\s*('[^']+'))/gi
    )
    for (const update of updates) {
      for (const literal of (update[1] ?? update[2]).matchAll(/'([^']+)'/g)) {
        words.push(literal[1])
      }
    }
  }
  return words
}

describe.skipIf(!sqliteAvailable())('reserved words', () => {
  // isReservedWord compares a claim's canonical form, which is punycode for a
  // Unicode name. A term stored any other way is a row the query never reaches,
  // and nothing reports it: the insert succeeds and the name stays claimable.
  it('stores only forms a claim can produce', () => {
    const unreachable = reservedWords().filter((word) => {
      try {
        return validateUsername(word).canonical !== word
      } catch {
        return true
      }
    })

    expect(unreachable).toEqual([])
  })

  // The trailing comment is the only part of an xn-- row a human can read, so
  // it has to be the term that row actually blocks, not a term someone meant to.
  it('blocks the display form each punycode row documents', async () => {
    const rows = encodedRows()
    expect(rows.length).toBeGreaterThan(0)

    // An xn-- row with no comment is unreadable to a reviewer, so require one.
    const undocumented = rows.filter((row) => row.display === null).map((row) => row.word)
    expect(undocumented).toEqual([])

    const documented = rows.filter(
      (row): row is { word: string; display: string } => row.display !== null
    )
    const { db } = createSqliteD1()
    for (const { word, display } of documented) {
      expect(validateUsername(display).canonical).toBe(word)
      expect(await isReservedWord(db, word)).toBe(true)
    }
  })

  // A migration that recategorizes a word it never inserts is a silent no-op on
  // every database but the one that already happened to hold the row.
  it('holds every word a migration recategorizes', () => {
    const words = recategorizedWords()
    expect(words.length).toBeGreaterThan(0)

    const present = new Set(reservedWords())
    expect(words.filter((word) => !present.has(word))).toEqual([])
  })
})
