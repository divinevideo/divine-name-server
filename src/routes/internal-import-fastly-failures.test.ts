import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import internalImport from './internal-import'
import { createSqliteD1, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'

// The real reconcile runs here (internal-import.test.ts mocks it), so this covers
// what an import does when Fastly rejects the write rather than when D1 does.
describe.skipIf(!sqliteAvailable())('import while Fastly rejects the write', () => {
  const pubkey = 'a'.repeat(64)
  let db: D1Database
  let sqlite: SqliteDb
  beforeEach(() => { ;({ db, sqlite } = createSqliteD1()) })
  afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

  it('answers 201, keeps the row, and leaves the name queued for the next attempt', async () => {
    // A 4xx is not retried, so this fails fast.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
    const response = await internalImport.request('/username/import', {
      method: 'POST', headers: { Authorization: 'Bearer import-test' }, body: JSON.stringify({ name: 'alice', pubkey }),
    }, { DB: db, USERNAME_IMPORT_TOKEN: 'import-test', FASTLY_API_TOKEN: 'synthetic-token', FASTLY_STORE_ID: 'test-store' })
    expect(response.status).toBe(201)
    expect(sqlite.prepare('SELECT name, status, claim_source FROM usernames').all())
      .toEqual([{ name: 'alice', status: 'active', claim_source: 'vine-import' }])
    expect(sqlite.prepare('SELECT username_canonical, action, attempt_count FROM fastly_sync_queue').all())
      .toEqual([{ username_canonical: 'alice', action: 'sync', attempt_count: 1 }])
  })
})
