// ABOUTME: Admin writes must not collide with a name its owner is mid-release on.
// ABOUTME: Runs against the real schema so the owned-name unique index is enforced.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'
import { prepareReleaseAttempt } from '../db/queries'
import { createExecutionContext } from '../db/test-helpers'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'

vi.mock('../utils/email', () => ({
  sendAssignmentNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendReservationConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}))

const OWNER = 'a'.repeat(64)

function app() {
  const instance = new Hono<{ Bindings: { DB: D1Database; BYPASS_LOCAL_AUTH?: string } }>()
  instance.route('/api/admin', admin)
  return instance
}

/** A pubkey whose only owned name is mid-release, plus a free name to move it to. */
async function ownerMidRelease() {
  const { db, sqlite } = createSqliteD1()
  seedUsername(sqlite, { name: 'alice', pubkey: OWNER, status: 'active' })
  seedUsername(sqlite, { name: 'bob', pubkey: null, status: 'revoked' })
  const prepared = await prepareReleaseAttempt(db, OWNER, 'alice', 'delete-attempt-00000001', 999, 100)
  expect(prepared.outcome).toBe('transitioned')
  return db
}

function post(path: string, body: object) {
  return new Request(`http://localhost/api/admin${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe.skipIf(!sqliteAvailable())('admin writes against an owner mid-release', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  })

  it('refuses to assign a second name to that owner', async () => {
    const db = await ownerMidRelease()
    const res = await app().fetch(post('/username/assign', { name: 'bob', pubkey: OWNER }), { DB: db, BYPASS_LOCAL_AUTH: 'true' }, createExecutionContext())

    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/pending release/i)
  })

  it('refuses to restore a second name to that owner', async () => {
    const db = await ownerMidRelease()
    const res = await app().fetch(post('/username/restore', { name: 'bob', pubkey: OWNER }), { DB: db, BYPASS_LOCAL_AUTH: 'true' }, createExecutionContext())

    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/pending release/i)
  })

  it('reports a bulk assign to that owner as a per-name failure', async () => {
    const db = await ownerMidRelease()
    const res = await app().fetch(
      post('/username/assign-bulk', { assignments: [{ name: 'bob', pubkey: OWNER }] }),
      { DB: db, BYPASS_LOCAL_AUTH: 'true' },
      createExecutionContext()
    )

    expect(res.status).toBe(200)
    const [result] = (await res.json() as { results: Array<{ success: boolean; error?: string }> }).results
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/pending release/i)
  })
})
