// ABOUTME: Payment-backed reservations keep proof recording consistent across requests.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import username from './username'
import { createSqliteD1, sqliteAvailable } from '../db/sqlite-test-helpers'
import { createExecutionContext } from '../db/test-helpers'
import { storeSpentProofs } from '../db/queries'
import type { JudgmentAI } from '../utils/judgment'

const handles: ReturnType<typeof createSqliteD1>[] = []
afterEach(() => {
  for (const { sqlite } of handles.splice(0)) sqlite.close()
  vi.unstubAllGlobals()
})

function setup(AI?: JudgmentAI) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call') }))
  const handle = createSqliteD1(); handles.push(handle)
  handle.sqlite.exec('DELETE FROM reserved_words')
  handle.sqlite.prepare("INSERT INTO reserved_words (word, category, created_at, match_scope) VALUES ('zxqword', 'slur', 1, 'token')").run()
  const app = new Hono(); app.route('/api/username', username)
  const env = { DB: handle.db, ALLOWED_MINTS: 'https://mint.example.test', AI, JUDGMENT_BLOCK_MIN: '0.5' }
  const submit = (name: string, secrets = ['synthetic-proof-a']) => {
    const payment = 'cashuA' + btoa(JSON.stringify({ token: [{ mint: env.ALLOWED_MINTS,
      proofs: secrets.map(secret => ({ amount: 2000, id: 'synthetic-id', secret, C: 'synthetic-commitment' })),
    }] })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return app.fetch(new Request('https://names.example.test/api/username/reserve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email: 'synthetic@example.test', cashu_token: payment }),
    }), env, createExecutionContext())
  }
  return { ...handle, submit }
}

function pairedJudgments(): JudgmentAI {
  let calls = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  return { run: async () => {
    if (++calls === 2) release()
    await barrier
    return { model: 'clef', answers: { meant: { type: 'noul', noul: 0.01 } } }
  } }
}

describe.skipIf(!sqliteAvailable())('payment-backed reservations', () => {
  it('accepts at most one concurrent submission of the same payment', async () => {
    const { submit, sqlite } = setup(pairedJudgments())
    const responses = await Promise.all([submit('zxqwordalpha'), submit('zxqwordbravo')])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reservation_tokens').get()).toEqual({ n: 1 })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM usernames WHERE status = 'pending-confirmation'").get()).toEqual({ n: 1 })
  })

  it('accepts independent payments submitted concurrently', async () => {
    const { submit, sqlite } = setup(pairedJudgments())
    const responses = await Promise.all([
      submit('zxqwordalpha', ['synthetic-proof-a']), submit('zxqwordbravo', ['synthetic-proof-b']),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 2 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reservation_tokens').get()).toEqual({ n: 2 })
  })

  it('leaves payment unused when a configured judgment fails', async () => {
    const { submit, sqlite } = setup({ run: async () => { throw new Error('synthetic service failure') } })
    expect((await submit('zxqwordalpha')).status).toBe(503)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reservation_tokens').get()).toEqual({ n: 0 })
  })

  it('leaves payment unused when a name is deterministically blocked', async () => {
    const { submit, sqlite } = setup()
    expect((await submit('zxqword')).status).toBe(403)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 0 })
  })

  it('rejects a duplicated proof list without recording any of it', async () => {
    const { submit, sqlite } = setup()
    expect((await submit('zxqwordalpha', ['synthetic-proof-a', 'synthetic-proof-a'])).status).toBe(409)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reservation_tokens').get()).toEqual({ n: 0 })
  })

  it('rolls back the whole proof set when one record already exists', async () => {
    const { db, sqlite } = setup()
    const proof = (secret: string) => ({ secret, amount: 2000 })
    expect(await storeSpentProofs(db, [proof('synthetic-proof-a')], 'synthetic-hash-a', 'zxqwordalpha')).toBe(true)
    expect(await storeSpentProofs(db, [proof('synthetic-proof-b'), proof('synthetic-proof-a')], 'synthetic-hash-b', 'zxqwordbravo')).toBe(false)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT proof_secret FROM spent_cashu_proofs WHERE proof_secret = ?').get('synthetic-proof-b')).toBeUndefined()
  })

  it('preserves an unrelated database failure and rolls back earlier records', async () => {
    const { db, sqlite } = setup()
    sqlite.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON spent_cashu_proofs
      WHEN NEW.proof_secret = 'synthetic-proof-b' BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END;`)
    await expect(storeSpentProofs(db, [
      { secret: 'synthetic-proof-a', amount: 2000 }, { secret: 'synthetic-proof-b', amount: 2000 },
    ], 'synthetic-hash', 'zxqwordalpha')).rejects.toThrow('synthetic database failure')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM spent_cashu_proofs').get()).toEqual({ n: 0 })
  })
})
