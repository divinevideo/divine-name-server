import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileUsernameFastly } from './username-fastly-reconcile'
import { createSqliteD1, seedUsername, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('reconciling one name to Fastly', () => {
  const pubkey = 'a'.repeat(64)
  let db: D1Database
  let sqlite: SqliteDb
  const queue = () => sqlite.prepare(
    'SELECT username_canonical, action, attempt_count, last_error FROM fastly_sync_queue'
  ).all()
  const reconcile = () => reconcileUsernameFastly({ DB: db, FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' }, 'alice')

  beforeEach(() => {
    ;({ db, sqlite } = createSqliteD1())
    seedUsername(sqlite, { name: 'alice', pubkey })
  })
  afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

  it('clears the queued task once the write is verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) =>
      options?.method === 'PUT' ? new Response('', { status: 200 }) : Response.json({ pubkey, relays: [], status: 'active' })))
    await reconcile()
    expect(queue()).toEqual([])
  })

  // A rejected write must be recorded against the queued task, not thrown: every
  // caller (import, sweep, repair) relies on the queue to retry it later. The
  // test database rejects a detached `db.batch`, as workerd does.
  it('keeps a rejected write queued and counts the attempt instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
    await expect(reconcile()).resolves.toBeUndefined()
    expect(queue()).toEqual([
      { username_canonical: 'alice', action: 'sync', attempt_count: 1, last_error: expect.stringContaining('401') },
    ])
  })

  it('keeps a write queued when it cannot be read back', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) =>
      new Response('', { status: options?.method === 'PUT' ? 200 : 404 })))
    await expect(reconcile()).resolves.toBeUndefined()
    expect(queue()).toEqual([
      { username_canonical: 'alice', action: 'sync', attempt_count: 1, last_error: expect.stringContaining('key missing') },
    ])
  })
})
