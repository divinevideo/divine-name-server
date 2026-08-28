// ABOUTME: Admin force-release of a held name and release-history lookup.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'
import { releaseHeldNameEarly, getUsernameReleaseHistory, getUsernameByName } from '../db/queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'
import { createExecutionContext } from '../db/test-helpers'

function createTestApp() {
  const app = new Hono<{ Bindings: { DB: D1Database; BYPASS_LOCAL_AUTH?: string } }>()
  app.route('/admin', admin)
  return app
}

describe.skipIf(!sqliteAvailable())('admin hold operability', () => {
  it('force-releases a held name to a claimable revoked row', async () => {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })

    expect(await releaseHeldNameEarly(db, 'alice', 500)).toBe(1)
    const row = await getUsernameByName(db, 'alice')
    expect(row?.status).toBe('revoked')
    expect(row?.recyclable).toBe(1)

    expect(await releaseHeldNameEarly(db, 'alice', 500)).toBe(0) // no longer held
  })

  it('reads release history newest-first', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(`INSERT INTO username_release_history (username_canonical, released_at, reason) VALUES ('alice', 100, 'deletion'), ('alice', 200, 'deletion')`).run()
    const history = await getUsernameReleaseHistory(db, 'alice')
    expect(history.map((h) => h.released_at)).toEqual([200, 100])
  })

  it('serves release history through the authenticated admin route', async () => {
    const { db, sqlite } = createSqliteD1()
    sqlite.prepare(`INSERT INTO username_release_history (username_canonical, released_at, reason) VALUES ('alice', 100, 'deletion')`).run()

    const response = await createTestApp().fetch(
      new Request('http://localhost/admin/username/alice/release-history'),
      { DB: db, BYPASS_LOCAL_AUTH: 'true' },
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, history: [{ username_canonical: 'alice', released_at: 100 }] })
  })

  it('validates release-history names and protects the route with admin auth', async () => {
    const { db } = createSqliteD1()
    const app = createTestApp()

    const invalid = await app.fetch(
      new Request('http://localhost/admin/username/a!/release-history'),
      { DB: db, BYPASS_LOCAL_AUTH: 'true' },
      createExecutionContext()
    )
    const unauthenticated = await app.fetch(
      new Request('http://localhost/admin/username/alice/release-history'),
      { DB: db },
      createExecutionContext()
    )

    expect(invalid.status).toBe(400)
    expect(unauthenticated.status).toBe(401)
  })

  it('releases a held name through the admin route and returns 409 on replay', async () => {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })
    const app = createTestApp()
    const env = { DB: db, BYPASS_LOCAL_AUTH: 'true' }

    const released = await app.fetch(
      new Request('http://localhost/admin/username/alice/release-hold', { method: 'POST' }),
      env,
      createExecutionContext()
    )
    const replay = await app.fetch(
      new Request('http://localhost/admin/username/alice/release-hold', { method: 'POST' }),
      env,
      createExecutionContext()
    )

    expect(released.status).toBe(200)
    expect(await released.json()).toMatchObject({ ok: true, status: 'revoked' })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ ok: false, error: 'Name is not currently held' })
  })
})
