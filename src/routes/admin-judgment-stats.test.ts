// ABOUTME: Judgment readouts are aggregate-only and inherit the admin auth boundary.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'
import { createSqliteD1, sqliteAvailable } from '../db/sqlite-test-helpers'
import { createExecutionContext } from '../db/test-helpers'

const handles: ReturnType<typeof createSqliteD1>[] = []
afterEach(() => {
  for (const { sqlite } of handles.splice(0)) sqlite.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function app() { const instance = new Hono(); instance.route('/api/admin', admin); return instance }
function failingDB() {
  const prepare = vi.fn(() => { throw new Error('synthetic database failure') })
  return { db: { prepare } as unknown as D1Database, prepare }
}

describe('judgment stats authorization', () => {
  it.each([
    ['https://names.divine.video', undefined, 403],
    ['https://names.divine.video', 'true', 403],
    ['https://names.admin.divine.video', undefined, 401],
    ['https://names.admin.divine.video', 'true', 401],
    ['http://admin.localhost', undefined, 401],
  ])('does not expose stats without the existing boundary (%s, bypass=%s)', async (origin, bypass, expected) => {
    const { db, prepare } = failingDB()
    const response = await app().fetch(new Request(origin + '/api/admin/judgment-stats'), { DB: db, BYPASS_LOCAL_AUTH: bypass }, createExecutionContext())
    expect(response.status).toBe(expected)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('keeps authorized database failures generic', async () => {
    const { db } = failingDB()
    const response = await app().fetch(new Request('http://admin.localhost/api/admin/judgment-stats'), { DB: db, BYPASS_LOCAL_AUTH: 'true' }, createExecutionContext())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: 'Internal server error' })
  })
})

describe.skipIf(!sqliteAvailable())('authorized judgment statistics', () => {
  it('returns only policy/range counts and reserved call volume, never individual records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call') }))
    vi.spyOn(Date, 'now').mockReturnValue(12_000_000)
    const handle = createSqliteD1(); handles.push(handle)
    handle.sqlite.prepare('INSERT INTO block_verdicts (canonical, blocklist_version, threshold, verdict, created_at, score) VALUES (?, 1, ?, ?, 100, ?)')
      .run('zxqwordextra', 'clef-intent-v1:0.6', 'blocked', 0.65)
    handle.sqlite.prepare('INSERT INTO jev_call_buckets VALUES (200, 3)').run()
    const response = await app().fetch(new Request('http://admin.localhost/api/admin/judgment-stats'), { DB: handle.db, BYPASS_LOCAL_AUTH: 'true' }, createExecutionContext())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true, blocklist_version: 1, cached_verdicts: 1, unscored_verdicts: 0,
      score_distribution: [{ policy: 'clef-intent-v1:0.6', verdict: 'blocked', lower: 0.6, upper: 0.7, upper_inclusive: false, cached_verdicts: 1 }],
      call_volume: { start_minute: 141, end_minute: 200, reserved_calls: 3, buckets: [{ minute_bucket: 200, reserved_calls: 3 }] },
    })
  })
})
