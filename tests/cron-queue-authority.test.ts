import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../src/db/sqlite-test-helpers'
import { createExecutionContext } from '../src/db/test-helpers'
import { enqueueFastlySyncTask, getQueuedFastlySyncTasks } from '../src/db/queries'

// The sweep must not hide a stale replay from the existing queue path.
vi.mock('../src/utils/fastly-sweep', () => ({ sweepFastlyNames: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe.skipIf(!sqliteAvailable())('cron queue follows current D1 ownership', () => {
  it('does not replay a stale payload after its name leaves the six-hour window', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'alice', pubkey: 'a'.repeat(64) })
      sqlite.prepare('UPDATE usernames SET atproto_did = ?, atproto_state = ? WHERE name = ?').run('did:plc:current', 'ready', 'alice')
      await enqueueFastlySyncTask(db, { username: 'alice', action: 'sync', data: { pubkey: 'b'.repeat(64), status: 'active', relays: [] } })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(100_000_000))
      const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
      vi.stubGlobal('fetch', fetcher)
      await worker.scheduled({} as ScheduledEvent, { DB: db, ASSETS: { fetch: async () => new Response('', { status: 404 }) }, FASTLY_API_TOKEN: 'test', FASTLY_STORE_ID: 'test' }, createExecutionContext())
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ pubkey: 'a'.repeat(64), atproto_did: 'did:plc:current', atproto_state: 'ready' })
      expect(await getQueuedFastlySyncTasks(db)).toEqual([])
    } finally { sqlite.close() }
  })
  it('keeps a newer queue generation created during the edge write', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'alice', pubkey: 'a'.repeat(64) })
      await enqueueFastlySyncTask(db, { username: 'alice', action: 'delete' })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(100_000_000))
      vi.stubGlobal('fetch', vi.fn(async () => {
        await enqueueFastlySyncTask(db, { username: 'alice', action: 'sync', data: { pubkey: 'a'.repeat(64), status: 'active', relays: [], atproto_did: 'did:plc:newer' } })
        return new Response('', { status: 200 })
      }))
      await worker.scheduled({} as ScheduledEvent, { DB: db, ASSETS: { fetch: async () => new Response('', { status: 404 }) }, FASTLY_API_TOKEN: 'test', FASTLY_STORE_ID: 'test' }, createExecutionContext())
      const tasks = await getQueuedFastlySyncTasks(db)
      expect(tasks).toHaveLength(1)
      expect(tasks[0].generation).toBe(2)
      expect(tasks[0].data?.atproto_did).toBe('did:plc:newer')
    } finally { sqlite.close() }
  })
})
