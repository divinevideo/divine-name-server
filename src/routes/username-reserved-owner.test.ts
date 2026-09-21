// ABOUTME: A blocklisted name still belongs to whoever already holds it.
// ABOUTME: Runs against the real schema so the owner branch of the claim upsert executes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createExecutionContext } from '../db/test-helpers'
import { createSqliteD1, seedUsername, sqliteAvailable, type SqliteDb } from '../db/sqlite-test-helpers'

const mocks = vi.hoisted(() => ({ verifyNip98Event: vi.fn() }))
vi.mock('../middleware/nip98', () => ({ verifyNip98Event: mocks.verifyNip98Event }))
vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  syncAndVerifyUsername: vi.fn().mockResolvedValue({ success: true, verified: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true }),
}))

import username from './username'

const OWNER = 'a'.repeat(64)
const STRANGER = 'b'.repeat(64)
const BLOCKED = 'nomap'

function app() {
  const instance = new Hono<{ Bindings: { DB: D1Database } }>()
  instance.route('/api/username', username)
  return instance
}

/** A blocklisted name, optionally already held by OWNER. */
function withBlockedName(options: { heldBy?: string; status?: string } = {}) {
  const { db, sqlite } = createSqliteD1()
  sqlite.prepare(
    `INSERT INTO reserved_words (word, category, reason, created_at) VALUES (?, 'child_safety', 'test', 100)`
  ).run(BLOCKED)
  if (options.heldBy) {
    seedUsername(sqlite, { name: BLOCKED, pubkey: options.heldBy, status: options.status ?? 'active' })
  }
  return { db, sqlite }
}

function claim(name: string, relays: string[]) {
  return new Request('http://localhost/api/username/claim', {
    method: 'POST',
    headers: { Authorization: 'Nostr test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, relays }),
  })
}

function storedRelays(sqlite: SqliteDb, name: string): string | null {
  const row = sqlite.prepare('SELECT relays FROM usernames WHERE username_canonical = ?').get(name)
  return (row as { relays: string | null } | undefined)?.relays ?? null
}

describe.skipIf(!sqliteAvailable())('claiming a name that is on the blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyNip98Event.mockResolvedValue(OWNER)
  })

  // The bug: re-claiming your own name is the only way to write relays
  // (queries.ts writes them nowhere else), so a 403 here freezes the owner's
  // NIP-05 record on relay hints they can never update.
  it('lets the current owner re-claim their own name and update their relays', async () => {
    const { db, sqlite } = withBlockedName({ heldBy: OWNER })

    const res = await app().fetch(claim(BLOCKED, ['wss://new.relay']), { DB: db }, createExecutionContext())

    expect(res.status).toBe(200)
    expect(storedRelays(sqlite, BLOCKED)).toBe(JSON.stringify(['wss://new.relay']))
  })

  it('still refuses anyone who does not already hold it', async () => {
    mocks.verifyNip98Event.mockResolvedValue(STRANGER)
    const { db } = withBlockedName({ heldBy: OWNER })

    const res = await app().fetch(claim(BLOCKED, ['wss://new.relay']), { DB: db }, createExecutionContext())

    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('Username is reserved')
  })

  it('still refuses a blocklisted name nobody holds', async () => {
    const { db } = withBlockedName()

    const res = await app().fetch(claim(BLOCKED, ['wss://new.relay']), { DB: db }, createExecutionContext())

    expect(res.status).toBe(403)
  })

  // Letting go of the name is the point at which the blocklist takes over. The
  // allowance is for keeping a name you hold, not for taking one back.
  it('still refuses the previous owner once the name is revoked', async () => {
    const { db } = withBlockedName({ heldBy: OWNER, status: 'revoked' })

    const res = await app().fetch(claim(BLOCKED, ['wss://new.relay']), { DB: db }, createExecutionContext())

    expect(res.status).toBe(403)
  })
})

describe.skipIf(!sqliteAvailable())('checking availability of a name on the blocklist', () => {
  function check(name: string) {
    return new Request(`http://localhost/api/username/check/${name}`)
  }

  // Reporting a held name as reserved contradicts nip05.ts, which keeps
  // resolving it, and withholds the owning pubkey clients use to tell
  // "taken by me" from "taken by someone else".
  it('reports a held name as taken, with its owner, rather than reserved', async () => {
    const { db } = withBlockedName({ heldBy: OWNER })

    const res = await app().fetch(check(BLOCKED), { DB: db }, createExecutionContext())

    expect(res.status).toBe(200)
    const body = await res.json() as { available: boolean; code?: string; status?: string; pubkey?: string }
    expect(body.available).toBe(false)
    expect(body.code).toBe('taken')
    expect(body.status).toBe('active')
    expect(body.pubkey).toBe(OWNER)
  })

  it('still reports a blocklisted name nobody holds as reserved', async () => {
    const { db } = withBlockedName()

    const res = await app().fetch(check(BLOCKED), { DB: db }, createExecutionContext())

    const body = await res.json() as { available: boolean; code?: string }
    expect(body.available).toBe(false)
    expect(body.code).toBe('reserved')
  })
})
