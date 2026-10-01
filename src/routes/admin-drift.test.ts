import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import admin from './admin'
import { createSqliteD1, seedUsername, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('admin drift tools', () => {
  let sqlite: SqliteDb
  let env: { DB: D1Database; FASTLY_API_TOKEN: string; FASTLY_STORE_ID: string; BYPASS_LOCAL_AUTH: string }
  beforeEach(() => {
    const database = createSqliteD1()
    sqlite = database.sqlite
    env = { DB: database.db, FASTLY_API_TOKEN: 'test-token', FASTLY_STORE_ID: 'test-store', BYPASS_LOCAL_AUTH: 'true' }
    seedUsername(sqlite, { name: 'alice', pubkey: 'a'.repeat(64) })
  })
  afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
  function request(path: string, body: unknown, host = 'admin.localhost') {
    return admin.request(`http://${host}/sync/fastly/${path}`, { method: 'POST', body: JSON.stringify(body) }, env)
  }
  it('enforces the existing admin host/auth boundary', async () => {
    expect((await request('compare', { source: 'd1' }, 'names.example.test')).status).toBe(403)
    const response = await admin.request('https://names.admin.divine.video/sync/fastly/compare', { method: 'POST', body: '{"source":"d1"}' }, { ...env, BYPASS_LOCAL_AUTH: undefined })
    expect(response.status).toBe(401)
  })
  it('defaults repairs to read-only and rejects orphan repair', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ pubkey: 'b'.repeat(64), relays: [], status: 'active' }))
    vi.stubGlobal('fetch', fetcher)
    const response = await request('repair', { name: 'alice' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ dry_run: true, difference: { name: 'alice', reason: 'pubkey-mismatch' } })
    expect(fetcher.mock.calls.every(call => call[1].method === 'GET')).toBe(true)
    expect(sqlite.prepare('SELECT * FROM fastly_sync_queue').all()).toHaveLength(0)
    expect((await request('repair', { name: 'orphan', dry_run: false })).status).toBe(409)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('explicit repair writes from D1, verifies and clears its queue generation', async () => {
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'PUT') return new Response('', { status: 200 })
      return Response.json({ pubkey: 'a'.repeat(64), relays: [], status: 'active' })
    })
    vi.stubGlobal('fetch', fetcher)
    expect((await request('repair', { name: 'alice', dry_run: false })).status).toBe(200)
    const put = fetcher.mock.calls.find(call => call[1]?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({ pubkey: 'a'.repeat(64), status: 'active' })
    expect(sqlite.prepare('SELECT * FROM fastly_sync_queue').all()).toHaveLength(0)
  })
  it('removes stale inactive entries using D1 authority without adopting orphan keys', async () => {
    seedUsername(sqlite, { name: 'held-name', status: 'held', pubkey: 'b'.repeat(64) })
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      return new Response('', { status: options?.method === 'DELETE' ? 200 : 404 })
    })
    vi.stubGlobal('fetch', fetcher)
    expect((await request('repair', { name: 'held-name', dry_run: false })).status).toBe(200)
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE')
    expect(sqlite.prepare('SELECT status FROM usernames WHERE name = ?').get('held-name')).toEqual({ status: 'held' })
  })
  it.each([
    ['an unknown source', { source: 'other' }],
    ['a d1 cursor that is not a number', { source: 'd1', cursor: '12garbage' }],
    ['a limit over 100', { source: 'kv', limit: 101 }],
    ['a limit that is not a whole number', { source: 'kv', limit: 1.5 }],
  ])('rejects invalid comparison input: %s', async (_label, body) => {
    expect((await request('compare', body)).status).toBe(400)
  })
  it('logs why a comparison or repair failed while answering with a generic 502', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    const compare = await request('compare', { source: 'kv' })
    expect(compare.status).toBe(502)
    expect(await compare.json()).toEqual({ ok: false, error: 'Comparison failed; retry this page' })
    expect(log).toHaveBeenCalledWith('Fastly comparison failed:', 'Fastly key listing failed')
    const repair = await request('repair', { name: 'alice' })
    expect(repair.status).toBe(502)
    expect(log).toHaveBeenCalledWith('Fastly repair failed:', 'Fastly comparison read failed for alice')
    log.mockRestore()
  })
})
