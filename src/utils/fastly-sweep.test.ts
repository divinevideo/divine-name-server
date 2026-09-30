import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweepFastlyNames } from './fastly-sweep'
import { reconcileUsernameFastly } from './username-fastly-reconcile'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'

vi.mock('./username-fastly-reconcile', () => ({ reconcileUsernameFastly: vi.fn().mockResolvedValue(undefined) }))
afterEach(() => vi.clearAllMocks())
describe.skipIf(!sqliteAvailable())('durable full-table sweep', () => {
  it('revisits old active and nonactive names across bounded pages and wraps', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      for (let i = 0; i < 101; i++) seedUsername(sqlite, { name: `name-${i}`, status: i === 100 ? 'held' : 'active' })
      const env = { DB: db, FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' }
      await sweepFastlyNames(env)
      expect(reconcileUsernameFastly).toHaveBeenCalledTimes(100)
      expect(sqlite.prepare('SELECT after_id FROM fastly_sweep_cursor').get()).toEqual({ after_id: 100 })
      await sweepFastlyNames(env)
      expect(reconcileUsernameFastly).toHaveBeenLastCalledWith(env, 'name-100')
      expect(sqlite.prepare('SELECT after_id FROM fastly_sweep_cursor').get()).toEqual({ after_id: 0 })
      await sweepFastlyNames(env)
      expect(reconcileUsernameFastly).toHaveBeenCalledTimes(201)
    } finally { sqlite.close() }
  })
  it('does not advance on a D1 failure and does nothing without Fastly configuration', async () => {
    const { db, sqlite } = createSqliteD1()
    try {
      seedUsername(sqlite, { name: 'alice' })
      await sweepFastlyNames({ DB: db })
      expect(reconcileUsernameFastly).not.toHaveBeenCalled()
      vi.mocked(reconcileUsernameFastly).mockRejectedValueOnce(new Error('D1 unavailable'))
      await expect(sweepFastlyNames({ DB: db, FASTLY_API_TOKEN: 'test', FASTLY_STORE_ID: 'test' })).rejects.toThrow('D1 unavailable')
      expect(sqlite.prepare('SELECT after_id FROM fastly_sweep_cursor').get()).toEqual({ after_id: 0 })
    } finally { sqlite.close() }
  })
})
