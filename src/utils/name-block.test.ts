// ABOUTME: Runs configured, disabled, cached and failed judgments through real SQLite.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'
import { approveProposal, bumpBlocklistVersion, listPendingProposals, proposeBlockWord } from '../db/block-verdicts'
import { resolveUsernameBlock, type BlockEnv } from './name-block'
import type { JudgmentAI } from './judgment'

const databases: ReturnType<typeof createSqliteD1>[] = []
afterEach(() => { for (const { sqlite } of databases.splice(0)) sqlite.close() })

function setup(word = 'zxqword', category = 'slur', scope = 'token') {
  const handle = createSqliteD1()
  databases.push(handle)
  handle.sqlite.exec('DELETE FROM reserved_words')
  handle.sqlite.prepare('INSERT INTO reserved_words (word, category, created_at, match_scope) VALUES (?, ?, 1, ?)')
    .run(word, category, scope)
  return handle
}

function ai(noul: number) {
  return { run: vi.fn(async (_model: string, _input: unknown) => ({
    model: 'clef', answers: { meant: { type: 'noul', noul }, belongs: { type: 'noul', noul } },
  })) }
}
const env = (AI: JudgmentAI, over: Partial<BlockEnv> = {}): BlockEnv => ({ AI, JUDGMENT_BLOCK_MIN: '0.5', ...over })

describe.skipIf(!sqliteAvailable())('resolveUsernameBlock', () => {
  it('blocks scoped hits even while AI is disabled', async () => {
    const { db } = setup()
    expect(await resolveUsernameBlock(db, 'aa-zxqword', {})).toEqual({ kind: 'reserved' })
  })

  it.each([{}, { JUDGMENT_BLOCK_MIN: '0.5' }, { AI: ai(0.9) }, { AI: ai(0.9), JUDGMENT_BLOCK_MIN: '' }])(
    'allows ambiguous names when the feature is not configured', async (disabled) => {
      const { db, sqlite } = setup()
      expect(await resolveUsernameBlock(db, 'zxqwordextra', disabled)).toEqual({ kind: 'clear' })
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM block_verdicts').get()).toEqual({ n: 0 })
    }
  )

  it('refuses invalid configured thresholds without spending a call', async () => {
    const { db } = setup(); const AI = ai(0.1)
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI, { JUDGMENT_BLOCK_MIN: 'oops' }))).toEqual({ kind: 'unavailable' })
    expect(AI.run).not.toHaveBeenCalled()
  })

  it('keeps host words and short content words scope-only', async () => {
    const first = setup('zxqword', 'system'); const AI = ai(0.9)
    expect(await resolveUsernameBlock(first.db, 'zxqwordextra', env(AI))).toEqual({ kind: 'clear' })
    const second = setup('zqx', 'slur')
    expect(await resolveUsernameBlock(second.db, 'zqxextra', env(AI))).toEqual({ kind: 'clear' })
    expect(await resolveUsernameBlock(second.db, 'aa-zqx', env(AI))).toEqual({ kind: 'reserved' })
    expect(AI.run).not.toHaveBeenCalled()
  })

  it.each(['slur', 'Foul Language ', 'Hate Groups', 'child_safety'])('judges eligible hidden words in %s', async (category) => {
    const { db } = setup('zxqword', category); const AI = ai(0.9)
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI))).toEqual({ kind: 'reserved' })
    expect(AI.run).toHaveBeenCalledTimes(1)
  })

  it.each([0.1, 0.9])('caches the complete verdict at score %s until the blocklist changes', async (score) => {
    const { db } = setup(); const AI = ai(score); const config = env(AI)
    const first = await resolveUsernameBlock(db, 'zxqwordextra', config)
    expect(first).toEqual({ kind: score >= 0.5 ? 'reserved' : 'clear' })
    expect(await resolveUsernameBlock(db, 'zxqwordextra', config)).toEqual(first)
    expect(AI.run).toHaveBeenCalledTimes(1)
    await bumpBlocklistVersion(db)
    await resolveUsernameBlock(db, 'zxqwordextra', config)
    expect(AI.run).toHaveBeenCalledTimes(2)
  })

  it('does not reuse another provider or threshold verdict', async () => {
    const { db, sqlite } = setup(); const AI = ai(0.2)
    sqlite.prepare("INSERT INTO block_verdicts VALUES ('zxqwordextra', 1, '0.5', 'blocked', 1)").run()
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI))).toEqual({ kind: 'clear' })
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI, { JUDGMENT_BLOCK_MIN: '0.1' }))).toEqual({ kind: 'reserved' })
    expect(AI.run).toHaveBeenCalledTimes(2)
  })

  it('does not cache older term data under a concurrently bumped version', async () => {
    const { db, sqlite } = setup(); const AI = ai(0.1)
    const wrapped: D1Database = Object.create(db)
    let bump = true
    wrapped.prepare = sql => {
      const statement = db.prepare(sql)
      if (sql.includes('FROM reserved_words') && bump) {
        const all = statement.all.bind(statement)
        statement.all = async <T>() => {
          const result = await all<T>()
          sqlite.exec('UPDATE blocklist_meta SET version = version + 1 WHERE id = 1')
          bump = false
          return result
        }
      }
      return statement
    }
    expect(await resolveUsernameBlock(wrapped, 'zxqwordextra', env(AI))).toEqual({ kind: 'clear' })
    const secondAI = ai(0.9)
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(secondAI))).toEqual({ kind: 'reserved' })
    expect(secondAI.run).toHaveBeenCalledTimes(1)
  })

  it('preserves the held invite-path no-spend behavior for an uncached ambiguous name', async () => {
    const { db } = setup(); const AI = ai(0.9)
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI), undefined, false)).toEqual({ kind: 'unavailable' })
    expect(AI.run).not.toHaveBeenCalled()
    await resolveUsernameBlock(db, 'zxqwordextra', env(AI))
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI), undefined, false)).toEqual({ kind: 'reserved' })
    expect(AI.run).toHaveBeenCalledTimes(1)
  })

  it('does not cache a configured failure', async () => {
    const { db } = setup()
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env({ run: async () => { throw new Error('down') } }))).toEqual({ kind: 'unavailable' })
    const AI = ai(0.1)
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI))).toEqual({ kind: 'clear' })
    expect(AI.run).toHaveBeenCalledTimes(1)
  })

  it('uses one global per-minute budget and never caches a partial clear', async () => {
    const { db, sqlite } = setup('abcd')
    sqlite.prepare("INSERT INTO reserved_words (word, category, created_at) VALUES ('bcde', 'slur', 1)").run()
    const AI = ai(0.1); const config = env(AI, { JUDGMENT_MAX_CALLS_PER_MINUTE: '1' })
    expect(await resolveUsernameBlock(db, 'abcdefg', config, 120)).toEqual({ kind: 'unavailable' })
    expect(await resolveUsernameBlock(db, 'abcdextra', config, 120)).toEqual({ kind: 'unavailable' })
    expect(AI.run).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM block_verdicts').get()).toEqual({ n: 0 })
    expect(await resolveUsernameBlock(db, 'abcdefg', env(AI), 180)).toEqual({ kind: 'clear' })
    expect(AI.run).toHaveBeenCalledTimes(3)
  })

  it('does not spend a proposal call for a pending word', async () => {
    const { db } = setup(); const AI = ai(0.9)
    await proposeBlockWord(db, 'extra', 0.9, 1)
    await resolveUsernameBlock(db, 'zxqwordextra', env(AI, { JUDGMENT_PROPOSE_MIN: '0.5' }))
    expect(AI.run).toHaveBeenCalledTimes(1)
  })

  it('charges each call to its actual minute when a judgment spans a boundary', async () => {
    const { db, sqlite } = setup('abcd')
    sqlite.prepare("INSERT INTO reserved_words (word, category, created_at) VALUES ('bcde', 'slur', 1)").run()
    let now = 120
    const run = vi.fn(async () => {
      now = 180
      return { model: 'clef', answers: { meant: { type: 'noul', noul: 0.1 } } }
    })
    expect(await resolveUsernameBlock(db, 'abcdefg', env({ run }, { JUDGMENT_MAX_CALLS_PER_MINUTE: '1' }), () => now)).toEqual({ kind: 'clear' })
    expect(sqlite.prepare('SELECT * FROM jev_call_buckets ORDER BY minute_bucket').all()).toEqual([
      { minute_bucket: 2, calls: 1 }, { minute_bucket: 3, calls: 1 },
    ])
  })

  it('judges every embedded term before caching a clear verdict', async () => {
    const { db, sqlite } = setup('abcd')
    for (const word of ['bcde', 'cdef', 'defg']) {
      sqlite.prepare("INSERT INTO reserved_words (word, category, created_at) VALUES (?, 'slur', 1)").run(word)
    }
    const run = vi.fn(async (_model: string, input: unknown) => {
      const flagged = (input as { state: { flagged_word: string } }).state.flagged_word
      return { model: 'clef', answers: { meant: { type: 'noul', noul: flagged === 'defg' ? 0.9 : 0.1 } } }
    })
    expect(await resolveUsernameBlock(db, 'abcdefg', env({ run }))).toEqual({ kind: 'reserved' })
    expect(run).toHaveBeenCalledTimes(4)
  })

  it.each(['0', '-1', 'oops'])('refuses without calling when the configured cap is %s', async (cap) => {
    const { db } = setup(); const AI = ai(0.1)
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI, { JUDGMENT_MAX_CALLS_PER_MINUTE: cap }))).toEqual({ kind: 'unavailable' })
    expect(AI.run).not.toHaveBeenCalled()
  })

  it('approves proposals as separate-word blocks; hidden uses still need judgment', async () => {
    const { db, sqlite } = setup(); const AI = ai(0.9)
    seedUsername(sqlite, { name: 'aazxqword' })
    seedUsername(sqlite, { name: 'aa-zxqw0rd' })
    await proposeBlockWord(db, 'zxqword', 0.9, 1)
    expect((await listPendingProposals(db))[0].affected_count).toBe(1)
    await approveProposal(db, 'zxqword', null, 2)
    expect(await resolveUsernameBlock(db, 'aa-zxqword', env(AI))).toEqual({ kind: 'reserved' })
    expect(AI.run).not.toHaveBeenCalled()
    expect(await resolveUsernameBlock(db, 'zxqwordextra', env(AI))).toEqual({ kind: 'reserved' })
    expect(AI.run).toHaveBeenCalledTimes(1)
  })

  it('uses digit substitution even on a row with the old option switched off', async () => {
    const { db, sqlite } = setup()
    sqlite.exec('UPDATE reserved_words SET match_leet = 0')
    expect(await resolveUsernameBlock(db, 'aa-zxqw0rd', {})).toEqual({ kind: 'reserved' })
  })

  it('counts with the expansion and repeat settings approval preserves on an existing word', async () => {
    const { db, sqlite } = setup('zxqw0rd')
    sqlite.exec('UPDATE reserved_words SET match_digit_expand = 1, match_repeats = 1')
    seedUsername(sqlite, { name: 'aa-zxqword' })
    await proposeBlockWord(db, 'zxqw0rd', 0.9, 1)
    expect((await listPendingProposals(db))[0].affected_count).toBe(1)
    await approveProposal(db, 'zxqw0rd', null, 2)
    expect(await resolveUsernameBlock(db, 'aa-zxqword', {})).toEqual({ kind: 'reserved' })
  })
})
