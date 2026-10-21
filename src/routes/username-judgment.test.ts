// ABOUTME: Public availability judgments use the same cached verdict as reservation.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import username from './username'
import { createExecutionContext } from '../db/test-helpers'
import { createSqliteD1, sqliteAvailable } from '../db/sqlite-test-helpers'
import { resolveUsernameBlock, type BlockEnv } from '../utils/name-block'
import { bumpBlocklistVersion } from '../db/block-verdicts'

const handles: ReturnType<typeof createSqliteD1>[] = []
afterEach(() => { for (const { sqlite } of handles.splice(0)) sqlite.close() })

describe.skipIf(!sqliteAvailable())('public availability judgments', () => {
  it.each([0.1, 0.9])('judges and caches score %s across availability and reservation resolution', async (noul) => {
    const handle = createSqliteD1(); handles.push(handle)
    handle.sqlite.exec('DELETE FROM reserved_words')
    handle.sqlite.prepare("INSERT INTO reserved_words (word, category, created_at, match_scope) VALUES ('zxqword', 'slur', 1, 'token')").run()
    const run = vi.fn(async () => ({ model: 'clef', answers: { meant: { type: 'noul', noul } } }))
    const bindings = { DB: handle.db, AI: { run }, JUDGMENT_BLOCK_MIN: '0.5' }
    const app = new Hono<{ Bindings: { DB: D1Database } & BlockEnv }>()
    app.route('/api/username', username)
    const request = () => new Request('https://names.example.test/api/username/check/zxqwordextra')
    const response = await app.fetch(request(), bindings, createExecutionContext())
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.available).toBe(noul < 0.5)
    expect(body).not.toHaveProperty('score')
    expect(body).not.toHaveProperty('model_score')
    expect(handle.sqlite.prepare('SELECT score FROM block_verdicts').get()).toEqual({ score: noul })
    await app.fetch(request(), bindings, createExecutionContext())
    expect(await resolveUsernameBlock(handle.db, 'zxqwordextra', bindings)).toEqual({ kind: noul < 0.5 ? 'clear' : 'reserved' })
    expect(run).toHaveBeenCalledTimes(1)
    await bumpBlocklistVersion(handle.db)
    await app.fetch(request(), bindings, createExecutionContext())
    expect(run).toHaveBeenCalledTimes(2)
  })
})
