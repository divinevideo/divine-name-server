// ABOUTME: Tests for ActivityPub WebFinger + NodeInfo discovery endpoints
// ABOUTME: Exercises the real worker (route precedence) with a fake D1

import { describe, it, expect, vi } from 'vitest'
import worker from '../index'
import { createFakeD1, type MockRecord } from '../db/test-helpers'

// The cron/scheduled path pulls in fastly-sync; mock it so importing the worker
// doesn't drag in real network code. Route handlers under test don't use it.
vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  syncAndVerifyUsername: vi.fn().mockResolvedValue({ success: true, verified: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true }),
  syncBatch: vi.fn().mockResolvedValue({ synced: 0, deleted: 0, failed: 0, errors: [], successes: [], failures: [] }),
  parseRelayHints: vi.fn().mockReturnValue([]),
}))

const records: MockRecord[] = [
  {
    id: 1, name: 'alice', username_display: 'Alice', username_canonical: 'alice',
    pubkey: 'abc123', status: 'active',
    created_at: 1700000000, updated_at: 1700000000, claimed_at: 1700000000,
  },
  {
    id: 2, name: 'reservedbob', username_display: 'reservedbob', username_canonical: 'reservedbob',
    pubkey: null, status: 'reserved',
    created_at: 1700000100, updated_at: 1700000100,
  },
]

const env = (db: D1Database) => ({
  DB: db,
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
} as any)

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext

describe('WebFinger', () => {
  it('returns a valid JRD for a known active username', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=acct:alice@divine.video'),
      env(db),
      ctx
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/jrd+json')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')

    const jrd = await res.json() as any
    expect(jrd.subject).toBe('acct:alice@divine.video')
    expect(jrd.aliases).toEqual([
      'https://alice.divine.video',
      'https://divine.video/ap/users/alice',
    ])
    const self = jrd.links.find((l: any) => l.rel === 'self')
    expect(self.type).toBe('application/activity+json')
    expect(self.href).toBe('https://divine.video/ap/users/alice')
    const profile = jrd.links.find((l: any) => l.rel === 'http://webfinger.net/rel/profile-page')
    expect(profile.type).toBe('text/html')
    expect(profile.href).toBe('https://alice.divine.video')
  })

  it('normalizes a mixed-case acct user to canonical', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=acct:Alice@divine.video'),
      env(db),
      ctx
    )
    expect(res.status).toBe(200)
    const jrd = await res.json() as any
    expect(jrd.subject).toBe('acct:alice@divine.video')
  })

  it('rejects acct resources for foreign domains', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=acct:alice@example.com'),
      env(db),
      ctx
    )

    expect(res.status).toBe(404)
  })

  it('allows bare username resources', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=alice'),
      env(db),
      ctx
    )

    expect(res.status).toBe(200)
    const jrd = await res.json() as any
    expect(jrd.subject).toBe('acct:alice@divine.video')
  })

  it('honors a configurable actor base URL', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=acct:alice@divine.video'),
      { ...env(db), AP_ACTOR_BASE_URL: 'https://ap.divine.video/ap/users/' },
      ctx
    )
    const jrd = await res.json() as any
    const self = jrd.links.find((l: any) => l.rel === 'self')
    expect(self.href).toBe('https://ap.divine.video/ap/users/alice')
    expect(jrd.aliases).toContain('https://ap.divine.video/ap/users/alice')
  })

  it('returns 404 for an unknown username', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=acct:nobody@divine.video'),
      env(db),
      ctx
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 for a non-active (reserved) username', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger?resource=acct:reservedbob@divine.video'),
      env(db),
      ctx
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 when resource is missing', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/webfinger'),
      env(db),
      ctx
    )
    expect(res.status).toBe(400)
  })
})

describe('NodeInfo', () => {
  it('serves the discovery document at /.well-known/nodeinfo', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/.well-known/nodeinfo'),
      env(db),
      ctx
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.links[0].rel).toBe('http://nodeinfo.diaspora.software/ns/schema/2.1')
    expect(body.links[0].href).toBe('https://divine.video/nodeinfo/2.1')
  })

  it('serves NodeInfo 2.1 with software=divine, activitypub, and an active user count', async () => {
    const db = createFakeD1(records)
    const res = await worker.fetch(
      new Request('https://divine.video/nodeinfo/2.1'),
      env(db),
      ctx
    )
    expect(res.status).toBe(200)
    const doc = await res.json() as any
    expect(doc.version).toBe('2.1')
    expect(doc.software.name).toBe('divine')
    expect(doc.protocols).toEqual(['activitypub'])
    expect(doc.openRegistrations).toBe(false)
    // Only one active record in the fixture (alice); reservedbob is reserved.
    expect(doc.usage.users.total).toBe(1)
    expect(doc.usage.localPosts).toBe(0)
  })
})
