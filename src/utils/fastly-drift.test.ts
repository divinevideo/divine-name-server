import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareFastlyPage } from './fastly-drift'
import { createSqliteD1, seedUsername, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('read-only drift comparison', () => {
  let sqlite: SqliteDb
  let env: { DB: D1Database; FASTLY_API_TOKEN: string; FASTLY_STORE_ID: string }
  const pubkey = 'a'.repeat(64)
  beforeEach(() => {
    const database = createSqliteD1()
    sqlite = database.sqlite
    env = { DB: database.db, FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' }
    seedUsername(sqlite, { name: 'alice', pubkey })
  })
  afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
  it('reports mismatched owners and orphans and retains Fastly pagination', async () => {
    const fetcher = vi.fn(async (url: string | URL, _options?: RequestInit) => {
      const pathname = new URL(url).pathname
      if (pathname.endsWith('/keys')) return Response.json({ data: ['other:key', 'user:alice', 'user:orphan'], meta: { next_cursor: 'next-page' } })
      return Response.json({ pubkey: 'b'.repeat(64), status: 'active', relays: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await compareFastlyPage(env, 'kv', 'first-page', 10)).toEqual({ checked: 2, cursor: 'next-page', differences: [
      { name: 'alice', reason: 'pubkey-mismatch' }, { name: 'orphan', reason: 'no-d1-row' },
    ] })
    expect(fetcher.mock.calls.every(call => call.length === 1 || !(call[1] as RequestInit)?.method || (call[1] as RequestInit)?.method === 'GET')).toBe(true)
    expect(String(fetcher.mock.calls[0][0])).toContain('cursor=first-page')
    expect(sqlite.prepare('SELECT * FROM fastly_sync_queue').all()).toHaveLength(0)
  })
  it('finds missing keys scanning active D1 rows and does not drop errors as clean', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const result = await compareFastlyPage(env, 'd1', null, 1)
    expect(result.differences).toEqual([{ name: 'alice', reason: 'missing-kv-key' }])
    expect(result.cursor).toBeTruthy()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(compareFastlyPage(env, 'd1', null, 1)).rejects.toThrow('read failed')
  })
  it('compares all metadata, handles malformed data and clean pages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ pubkey, status: 'active', relays: [] })))
    expect((await compareFastlyPage(env, 'd1', null, 100)).differences).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ pubkey, status: 'active' })))
    expect((await compareFastlyPage(env, 'd1', null, 100)).differences).toEqual([{ name: 'alice', reason: 'invalid-kv-data' }])
  })
})
