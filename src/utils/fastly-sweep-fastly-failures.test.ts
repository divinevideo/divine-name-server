import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweepFastlyNames } from './fastly-sweep'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'

// The real reconcile runs here (fastly-sweep.test.ts mocks it), so these cover
// what the sweep does when Fastly misbehaves rather than when D1 does.
describe.skipIf(!sqliteAvailable())('sweeping while Fastly misbehaves', () => {
  const alice = 'a'.repeat(64)
  const bob = 'b'.repeat(64)
  afterEach(() => vi.unstubAllGlobals())

  it('keeps sweeping past a name whose stored value cannot be verified, leaving it queued', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'alice', pubkey: alice })
      seedUsername(sqlite, { name: 'bob', pubkey: bob })
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options?: RequestInit) => {
        if (options?.method === 'PUT') return new Response('', { status: 200 })
        // alice reads back without a relays list; bob reads back correctly
        return new URL(url).pathname.endsWith('user%3Aalice')
          ? Response.json({ pubkey: alice, status: 'active' })
          : Response.json({ pubkey: bob, relays: [], status: 'active' })
      }))
      await sweepFastlyNames({ DB: db, FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' })
      expect(sqlite.prepare('SELECT username_canonical, attempt_count FROM fastly_sync_queue').all())
        .toEqual([{ username_canonical: 'alice', attempt_count: 1 }])
      expect(sqlite.prepare('SELECT after_id FROM fastly_sweep_cursor').get()).toEqual({ after_id: 0 })
    } finally { sqlite.close() }
  })

  // A 4xx is not retried, so these fail fast. The test database rejects a detached
  // `db.batch` as workerd does, which is what recording these failures used to hit.
  it('queues every name whose write is rejected and still reaches the end of the page', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'alice', pubkey: alice })
      seedUsername(sqlite, { name: 'bob', pubkey: bob })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
      await sweepFastlyNames({ DB: db, FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' })
      expect(sqlite.prepare('SELECT username_canonical, action, attempt_count FROM fastly_sync_queue ORDER BY username_canonical').all()).toEqual([
        { username_canonical: 'alice', action: 'sync', attempt_count: 1 },
        { username_canonical: 'bob', action: 'sync', attempt_count: 1 },
      ])
      expect(sqlite.prepare('SELECT after_id FROM fastly_sweep_cursor').get()).toEqual({ after_id: 0 })
    } finally { sqlite.close() }
  })

  it('queues a rejected delete for a name that is no longer active', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'gone', status: 'held', pubkey: null })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
      await sweepFastlyNames({ DB: db, FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' })
      expect(sqlite.prepare('SELECT username_canonical, action, attempt_count FROM fastly_sync_queue').all())
        .toEqual([{ username_canonical: 'gone', action: 'delete', attempt_count: 1 }])
    } finally { sqlite.close() }
  })
})
