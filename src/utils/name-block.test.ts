// ABOUTME: Judgment runs only for an embedding, caches the verdict, and refuses
// ABOUTME: the name when the model cannot be asked.

import { describe, expect, it } from 'vitest'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'
import { listPendingProposals, proposeBlockWord } from '../db/block-verdicts'
import { resolveUsernameBlock } from './name-block'
import type { JevFetch } from './jev'

const describeSqlite = sqliteAvailable() ? describe : describe.skip

function jev(noul: number, calls: string[]): JevFetch {
  return async (_url, init) => {
    calls.push(String(init.body))
    return new Response(JSON.stringify({ answers: { meant: { noul }, belongs: { noul } } }), { status: 200 })
  }
}

describeSqlite('resolveUsernameBlock', () => {
  it('blocks a scoped hit without calling out', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    const calls: string[] = []
    const outcome = await resolveUsernameBlock(db, 'aa-zxqword', { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' }, jev(0.9, calls))
    expect(outcome).toEqual({ kind: 'reserved' })
    expect(calls).toEqual([])
    sqlite.close()
  })

  it('leaves a system word inside a longer name clear', async () => {
    const { db, sqlite } = createSqliteD1()
    const calls: string[] = []
    const outcome = await resolveUsernameBlock(db, 'myadmin', { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' }, jev(0.99, calls))
    expect(outcome).toEqual({ kind: 'clear' })
    expect(calls).toEqual([])
    sqlite.close()
  })

  it('does not call Jev for a public availability check on an embedding', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    const calls: string[] = []
    const outcome = await resolveUsernameBlock(
      db,
      'zxqwordextra',
      { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' },
      jev(0.8, calls),
      1_700_000_000,
      false
    )
    expect(outcome).toEqual({ kind: 'unavailable' })
    expect(calls).toEqual([])
    sqlite.close()
  })

  it('asks once about an embedding and caches a block', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    const calls: string[] = []
    const env = { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' }
    const first = await resolveUsernameBlock(db, 'zxqwordextra', env, jev(0.8, calls), 1_700_000_000)
    const second = await resolveUsernameBlock(db, 'zxqwordextra', env, jev(0.1, calls), 1_700_000_000)
    expect(first).toEqual({ kind: 'reserved' })
    expect(second).toEqual({ kind: 'reserved' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('reading_if_word_is_intended')
    expect(calls[0]).not.toContain('belongs')
    sqlite.close()
  })

  it('allows an embedding the judgment says was an accident', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    const outcome = await resolveUsernameBlock(
      db,
      'zxqwordextra',
      { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' },
      jev(0.2, []),
      1_700_000_000
    )
    expect(outcome).toEqual({ kind: 'clear' })
    sqlite.close()
  })

  it('refuses an embedding when the model is unreachable and does not cache that', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    const failing: JevFetch = async () => { throw new Error('down') }
    const env = { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' }
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env, failing, 1_700_000_000)).toEqual({ kind: 'unavailable' })
    const calls: string[] = []
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env, jev(0.1, calls), 1_700_000_100)).toEqual({ kind: 'clear' })
    expect(calls).toHaveLength(1)
    sqlite.close()
  })

  it('judges every embedded word before caching a clear', async () => {
    const { db, sqlite } = createSqliteD1()
    for (const word of ['abcd', 'bcde', 'cdef', 'defg']) {
      sqlite.prepare(
        `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES (?, 'offensive', NULL, 1, 'token')`
      ).run(word)
    }
    const calls: string[] = []
    const fetchImpl: JevFetch = async (_url, init) => {
      const body = String(init.body)
      calls.push(body)
      const flagged = (JSON.parse(body) as { state?: { flagged_word?: string } }).state?.flagged_word
      const noul = flagged === 'defg' ? 0.9 : 0.1
      return new Response(JSON.stringify({ answers: { meant: { noul }, belongs: { noul: 0.1 } } }), { status: 200 })
    }
    const outcome = await resolveUsernameBlock(
      db,
      'abcdefg',
      { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5' },
      fetchImpl,
      1_700_000_000
    )
    expect(outcome).toEqual({ kind: 'reserved' })
    expect(calls).toHaveLength(4)
    sqlite.close()
  })

  it('does not cache a clear when the call cap stops before every embedded word', async () => {
    const { db, sqlite } = createSqliteD1()
    for (const word of ['abcd', 'bcde']) {
      sqlite.prepare(
        `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES (?, 'offensive', NULL, 1, 'token')`
      ).run(word)
    }
    const calls: string[] = []
    const env = { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5', JEV_MAX_CALLS_PER_MINUTE: '1' }
    const first = await resolveUsernameBlock(db, 'abcdefg', env, jev(0.1, calls), 1_700_000_000)
    expect(first).toEqual({ kind: 'unavailable' })
    const later = await resolveUsernameBlock(db, 'abcdefg', { ...env, JEV_MAX_CALLS_PER_MINUTE: '5' }, jev(0.1, calls), 1_700_000_060)
    expect(later).toEqual({ kind: 'clear' })
    expect(calls.length).toBeGreaterThan(1)
    sqlite.close()
  })

  it('does not spend a proposal call on a word that is already pending', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    await proposeBlockWord(db, 'extra', 0.9, 1)
    const calls: string[] = []
    const outcome = await resolveUsernameBlock(
      db,
      'zxqwordextra',
      { TYPESAFE_API_KEY: 'test', JEV_BLOCK_MIN: '0.5', JEV_PROPOSE_MIN: '0.5' },
      jev(0.9, calls),
      1_700_000_000
    )
    expect(outcome).toEqual({ kind: 'reserved' })
    expect(calls.some((body) => body.includes('belongs'))).toBe(false)
    sqlite.close()
  })

  it('counts a leet spelling in the proposal impact', async () => {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 's4ckname' })
    seedUsername(sqlite, { name: 's-4-ck-extra' })
    seedUsername(sqlite, { name: 'brightlantern' })
    seedUsername(sqlite, { name: 'xn--sack', canonical: 'xn--sack' })
    await proposeBlockWord(db, 'sack', 0.9, 1)
    const proposals = await listPendingProposals(db)
    expect(proposals.find((row) => row.word === 'sack')?.affected_count).toBe(2)
    sqlite.close()
  })

  it('refuses an embedding when no threshold is configured, without calling', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(
      `INSERT INTO reserved_words (word, category, reason, created_at, match_scope) VALUES ('zxqword', 'offensive', NULL, 1, 'token')`
    ).run()
    const calls: string[] = []
    const outcome = await resolveUsernameBlock(db, 'zxqwordextra', { TYPESAFE_API_KEY: 'test' }, jev(0.99, calls))
    expect(outcome).toEqual({ kind: 'unavailable' })
    expect(calls).toEqual([])
    sqlite.close()
  })
})
