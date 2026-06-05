# Fastly KV Cron Sync Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timing-out full-table Fastly KV sync with delta cron + concurrent batch processing + paginated admin full-sync endpoint + CLI backfill script + admin UI button.

**Architecture:** Delta sync (2-hour window) for the hourly cron, `syncBatch` utility with bounded concurrency (10 parallel Fastly API calls), cursor-paginated admin endpoint for full syncs, shell script for CLI backfill, React button for admin UI.

**Tech Stack:** Cloudflare Workers (Hono), D1, Fastly KV API, Vitest, React (admin-ui), shell/curl

**Branch:** `fix/cron-sync-scaling` (already has WIP delta sync commit)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/fastly-sync.ts` | Modify | Add `syncBatch` with bounded concurrency |
| `src/utils/fastly-sync.test.ts` | Create | Tests for `syncBatch` |
| `src/db/queries.ts` | Modify | Add `getActiveUsernamesPaginated` query |
| `src/db/queries.test.ts` | Modify | Add tests for new query |
| `src/index.ts` | Modify | Refactor cron handler to use `syncBatch` |
| `src/index.test.ts` | Create | Tests for scheduled handler |
| `src/routes/admin.ts` | Modify | Refactor `/sync/fastly` to paginated |
| `src/routes/admin.test.ts` | Modify | Add tests for paginated sync endpoint |
| `migrations/0010_add_updated_at_index.sql` | Create | Index on `updated_at` |
| `scripts/backfill-fastly-kv.sh` | Create | CLI backfill script |
| `admin-ui/src/api/client.ts` | Modify | Add `syncFastlyPage` API function |
| `admin-ui/src/types/index.ts` | Modify | Add `FastlySyncPageResponse` type |
| `admin-ui/src/pages/Dashboard.tsx` | Modify | Add Sync to Fastly button + progress |

---

### Task 1: `syncBatch` — concurrent sync utility

**Files:**
- Create: `src/utils/fastly-sync.test.ts`
- Modify: `src/utils/fastly-sync.ts`

- [ ] **Step 1: Write tests for `syncBatch`**

Create `src/utils/fastly-sync.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { syncBatch, type SyncItem, type FastlyEnv } from './fastly-sync'

const env: FastlyEnv = {
  FASTLY_API_TOKEN: 'test-token',
  FASTLY_STORE_ID: 'test-store-id',
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('syncBatch', () => {
  it('should sync active users and delete revoked users', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })

    const items: SyncItem[] = [
      { username: 'alice', action: 'sync', data: { pubkey: 'abc123', relays: [], status: 'active' } },
      { username: 'bob', action: 'delete' },
    ]

    const result = await syncBatch(env, items)

    expect(result.synced).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('should handle partial failures without aborting', async () => {
    let callCount = 0
    mockFetch.mockImplementation(async () => {
      callCount++
      if (callCount <= 3) {
        // First item: all 3 retries fail
        return { ok: false, status: 500, text: async () => 'server error' }
      }
      // Second item succeeds
      return { ok: true, status: 200, text: async () => '' }
    })

    const items: SyncItem[] = [
      { username: 'failing', action: 'sync', data: { pubkey: 'aaa', relays: [], status: 'active' } },
      { username: 'passing', action: 'sync', data: { pubkey: 'bbb', relays: [], status: 'active' } },
    ]

    const result = await syncBatch(env, items)

    expect(result.synced).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('failing')
  })

  it('should respect concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0

    mockFetch.mockImplementation(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent--
      return { ok: true, status: 200, text: async () => '' }
    })

    const items: SyncItem[] = Array.from({ length: 20 }, (_, i) => ({
      username: `user${i}`,
      action: 'sync' as const,
      data: { pubkey: `pk${i}`, relays: [], status: 'active' as const },
    }))

    await syncBatch(env, items, { concurrency: 3 })

    expect(maxConcurrent).toBeLessThanOrEqual(3)
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('should return zeros for empty items array', async () => {
    const result = await syncBatch(env, [])

    expect(result.synced).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('should skip sync when Fastly config is missing', async () => {
    const result = await syncBatch({ FASTLY_API_TOKEN: undefined, FASTLY_STORE_ID: undefined }, [
      { username: 'alice', action: 'sync', data: { pubkey: 'abc', relays: [], status: 'active' } },
    ])

    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain('alice')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/fastly-sync.test.ts`
Expected: FAIL — `syncBatch` is not exported from `./fastly-sync`

- [ ] **Step 3: Add `SyncItem` type and `syncBatch` to `fastly-sync.ts`**

Add to `src/utils/fastly-sync.ts` after existing exports:

```typescript
export interface SyncItem {
  username: string
  action: 'sync' | 'delete'
  data?: UsernameKVData
}

export interface SyncBatchResult {
  synced: number
  deleted: number
  failed: number
  errors: string[]
}

export async function syncBatch(
  env: FastlyEnv,
  items: SyncItem[],
  options?: { concurrency?: number }
): Promise<SyncBatchResult> {
  const concurrency = options?.concurrency ?? 10
  const result: SyncBatchResult = { synced: 0, deleted: 0, failed: 0, errors: [] }

  if (items.length === 0) return result

  const queue = [...items]
  const inflight = new Set<Promise<void>>()

  const processItem = async (item: SyncItem): Promise<void> => {
    if (item.action === 'sync' && item.data) {
      const res = await syncUsernameToFastly(env, item.username, item.data)
      if (res.success) result.synced++
      else {
        result.failed++
        result.errors.push(`${item.username}: ${res.error}`)
      }
    } else if (item.action === 'delete') {
      const res = await deleteUsernameFromFastly(env, item.username)
      if (res.success) result.deleted++
      else {
        result.failed++
        result.errors.push(`${item.username}: ${res.error}`)
      }
    }
  }

  while (queue.length > 0 || inflight.size > 0) {
    while (queue.length > 0 && inflight.size < concurrency) {
      const item = queue.shift()!
      const promise = processItem(item).then(() => {
        inflight.delete(promise)
      })
      inflight.add(promise)
    }
    if (inflight.size > 0) {
      await Promise.race(inflight)
    }
  }

  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/fastly-sync.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/fastly-sync.ts src/utils/fastly-sync.test.ts
git commit -m "feat: add syncBatch with bounded concurrency for Fastly KV sync"
```

---

### Task 2: D1 migration — `updated_at` index

**Files:**
- Create: `migrations/0010_add_updated_at_index.sql`

- [ ] **Step 1: Create the migration file**

Create `migrations/0010_add_updated_at_index.sql`:

```sql
-- Index for delta sync query (getUsernamesUpdatedSince)
CREATE INDEX IF NOT EXISTS idx_usernames_updated_at ON usernames (updated_at);
```

- [ ] **Step 2: Test the migration locally**

Run: `npx wrangler d1 execute divine-name-server-db --local --file migrations/0010_add_updated_at_index.sql`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add migrations/0010_add_updated_at_index.sql
git commit -m "migration: add updated_at index for delta sync query"
```

---

### Task 3: Paginated query — `getActiveUsernamesPaginated`

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/db/queries.test.ts`

- [ ] **Step 1: Write tests for the paginated query**

Read the existing test file at `src/db/queries.test.ts` to understand its mock DB pattern. Then add tests at the end of the file:

```typescript
describe('getActiveUsernamesPaginated', () => {
  it('should return first page when cursor is null', async () => {
    // Insert 3 active users with pubkeys
    await db.prepare(
      `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
       VALUES ('alice', 'alice', 'pk1', 'active', 'self-service', 1000, 1000),
              ('bob', 'bob', 'pk2', 'active', 'self-service', 1001, 1001),
              ('carol', 'carol', 'pk3', 'active', 'self-service', 1002, 1002)`
    ).run()

    const results = await getActiveUsernamesPaginated(db, null, 2)

    expect(results.length).toBe(2)
    expect(results[0].username_canonical).toBe('alice')
    expect(results[1].username_canonical).toBe('bob')
  })

  it('should return next page using cursor', async () => {
    await db.prepare(
      `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
       VALUES ('alice', 'alice', 'pk1', 'active', 'self-service', 1000, 1000),
              ('bob', 'bob', 'pk2', 'active', 'self-service', 1001, 1001),
              ('carol', 'carol', 'pk3', 'active', 'self-service', 1002, 1002)`
    ).run()

    const firstPage = await getActiveUsernamesPaginated(db, null, 2)
    const lastId = firstPage[firstPage.length - 1].id
    const secondPage = await getActiveUsernamesPaginated(db, lastId, 2)

    expect(secondPage.length).toBe(1)
    expect(secondPage[0].username_canonical).toBe('carol')
  })

  it('should return empty array when cursor is past last record', async () => {
    await db.prepare(
      `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
       VALUES ('alice', 'alice', 'pk1', 'active', 'self-service', 1000, 1000)`
    ).run()

    const results = await getActiveUsernamesPaginated(db, 9999, 10)

    expect(results.length).toBe(0)
  })

  it('should only return active usernames', async () => {
    await db.prepare(
      `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
       VALUES ('active1', 'active1', 'pk1', 'active', 'self-service', 1000, 1000),
              ('revoked1', 'revoked1', 'pk2', 'revoked', 'self-service', 1001, 1001),
              ('active2', 'active2', 'pk3', 'active', 'self-service', 1002, 1002)`
    ).run()

    const results = await getActiveUsernamesPaginated(db, null, 10)

    expect(results.length).toBe(2)
    expect(results.every(r => r.status === 'active')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/queries.test.ts`
Expected: FAIL — `getActiveUsernamesPaginated` is not exported

- [ ] **Step 3: Implement `getActiveUsernamesPaginated`**

Add to `src/db/queries.ts` after `getAllActiveUsernames`:

```typescript
export async function getActiveUsernamesPaginated(
  db: D1Database,
  afterId: number | null,
  limit: number
): Promise<Username[]> {
  if (afterId !== null) {
    const result = await db.prepare(
      'SELECT * FROM usernames WHERE status = ? AND id > ? ORDER BY id LIMIT ?'
    ).bind('active', afterId, limit).all<Username>()
    return result.results
  }
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE status = ? ORDER BY id LIMIT ?'
  ).bind('active', limit).all<Username>()
  return result.results
}
```

- [ ] **Step 4: Import `getActiveUsernamesPaginated` in the test file**

Add to the import in `src/db/queries.test.ts`:

```typescript
import { ..., getActiveUsernamesPaginated } from './queries'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db/queries.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/queries.ts src/db/queries.test.ts
git commit -m "feat: add getActiveUsernamesPaginated for cursor-based full sync"
```

---

### Task 4: Refactor cron handler to use `syncBatch`

**Files:**
- Modify: `src/index.ts`
- Create: `src/index.test.ts`

- [ ] **Step 1: Write tests for the scheduled handler**

Create `src/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./db/queries', () => ({
  expireStaleReservations: vi.fn().mockResolvedValue(0),
  getUsernamesUpdatedSince: vi.fn().mockResolvedValue([]),
}))

vi.mock('./utils/fastly-sync', () => ({
  syncBatch: vi.fn().mockResolvedValue({ synced: 0, deleted: 0, failed: 0, errors: [] }),
  parseRelayHints: vi.fn((r: string | null) => r ? JSON.parse(r) : []),
}))

import { expireStaleReservations, getUsernamesUpdatedSince } from './db/queries'
import { syncBatch, parseRelayHints } from './utils/fastly-sync'

// Import the default export to get the scheduled handler
import worker from './index'

const mockEnv = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  FASTLY_API_TOKEN: 'test-token',
  FASTLY_STORE_ID: 'test-store',
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
}

describe('scheduled handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should expire stale reservations before syncing', async () => {
    await worker.scheduled({} as ScheduledEvent, mockEnv, mockCtx as any)

    expect(expireStaleReservations).toHaveBeenCalledWith(mockEnv.DB)
  })

  it('should query for recently changed usernames with 2-hour window', async () => {
    const now = Math.floor(Date.now() / 1000)
    await worker.scheduled({} as ScheduledEvent, mockEnv, mockCtx as any)

    const calledWith = vi.mocked(getUsernamesUpdatedSince).mock.calls[0][1]
    const expectedMin = now - (2 * 60 * 60) - 5
    const expectedMax = now - (2 * 60 * 60) + 5
    expect(calledWith).toBeGreaterThanOrEqual(expectedMin)
    expect(calledWith).toBeLessThanOrEqual(expectedMax)
  })

  it('should call syncBatch with active users mapped to sync items', async () => {
    vi.mocked(getUsernamesUpdatedSince).mockResolvedValue([
      {
        id: 1, name: 'alice', username_display: 'Alice', username_canonical: 'alice',
        pubkey: 'pk1', relays: '["wss://relay.example.com"]', status: 'active',
        email: null, recyclable: 0, created_at: 1000, updated_at: 2000,
        claimed_at: 1000, revoked_at: null, reserved_reason: null,
        admin_notes: null, reservation_email: null, confirmation_token: null,
        reservation_expires_at: null, subscription_expires_at: null,
        claim_source: 'self-service', created_by: null,
        atproto_did: null, atproto_state: null,
      },
    ] as any)

    await worker.scheduled({} as ScheduledEvent, mockEnv, mockCtx as any)

    expect(syncBatch).toHaveBeenCalledWith(
      mockEnv,
      [{ username: 'alice', action: 'sync', data: expect.objectContaining({ pubkey: 'pk1' }) }],
      { concurrency: 10 }
    )
  })

  it('should map revoked users to delete items', async () => {
    vi.mocked(getUsernamesUpdatedSince).mockResolvedValue([
      {
        id: 2, name: 'bob', username_display: 'Bob', username_canonical: 'bob',
        pubkey: 'pk2', relays: null, status: 'revoked',
        email: null, recyclable: 1, created_at: 1000, updated_at: 2000,
        claimed_at: 1000, revoked_at: 2000, reserved_reason: null,
        admin_notes: null, reservation_email: null, confirmation_token: null,
        reservation_expires_at: null, subscription_expires_at: null,
        claim_source: 'self-service', created_by: null,
        atproto_did: null, atproto_state: null,
      },
    ] as any)

    await worker.scheduled({} as ScheduledEvent, mockEnv, mockCtx as any)

    expect(syncBatch).toHaveBeenCalledWith(
      mockEnv,
      [{ username: 'bob', action: 'delete', data: undefined }],
      { concurrency: 10 }
    )
  })

  it('should filter out active users without pubkeys', async () => {
    vi.mocked(getUsernamesUpdatedSince).mockResolvedValue([
      {
        id: 3, name: 'nopubkey', username_display: 'NoPubkey', username_canonical: 'nopubkey',
        pubkey: null, relays: null, status: 'active',
        email: null, recyclable: 0, created_at: 1000, updated_at: 2000,
        claimed_at: null, revoked_at: null, reserved_reason: 'Reserved',
        admin_notes: null, reservation_email: null, confirmation_token: null,
        reservation_expires_at: null, subscription_expires_at: null,
        claim_source: 'admin', created_by: null,
        atproto_did: null, atproto_state: null,
      },
    ] as any)

    await worker.scheduled({} as ScheduledEvent, mockEnv, mockCtx as any)

    expect(syncBatch).toHaveBeenCalledWith(mockEnv, [], { concurrency: 10 })
  })

  it('should handle empty change set without calling syncBatch with items', async () => {
    vi.mocked(getUsernamesUpdatedSince).mockResolvedValue([])

    await worker.scheduled({} as ScheduledEvent, mockEnv, mockCtx as any)

    expect(syncBatch).toHaveBeenCalledWith(mockEnv, [], { concurrency: 10 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — scheduled handler doesn't use `syncBatch` yet (current code uses inline loop)

- [ ] **Step 3: Refactor the scheduled handler in `src/index.ts`**

Replace the entire `scheduled` method. Update imports at the top:

```typescript
import { getUsernamesUpdatedSince, expireStaleReservations } from './db/queries'
import { syncBatch, parseRelayHints, type SyncItem } from './utils/fastly-sync'
```

Replace the scheduled handler body:

```typescript
async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
  const expired = await expireStaleReservations(env.DB)
  if (expired > 0) {
    console.log(`Cron: expired ${expired} stale pending-confirmation reservations`)
  }

  const twoHoursAgo = Math.floor(Date.now() / 1000) - (2 * 60 * 60)
  const changed = await getUsernamesUpdatedSince(env.DB, twoHoursAgo)

  const syncable = changed.filter(u =>
    (u.status === 'active' && u.pubkey) || u.status === 'revoked' || u.status === 'burned'
  )

  const items: SyncItem[] = syncable.map(u => ({
    username: u.username_canonical || u.name,
    action: (u.status === 'active') ? 'sync' as const : 'delete' as const,
    data: (u.status === 'active') ? {
      pubkey: u.pubkey!,
      relays: parseRelayHints(u.relays),
      status: 'active' as const,
      atproto_did: u.atproto_did,
      atproto_state: u.atproto_state,
    } : undefined,
  }))

  const results = await syncBatch(env, items, { concurrency: 10 })
  console.log(`Cron delta sync: ${changed.length} changed, ${results.synced} synced, ${results.deleted} deleted, ${results.failed} failed`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/index.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Run all tests to check for regressions**

Run: `npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: refactor cron handler to use syncBatch with concurrency"
```

---

### Task 5: Paginated admin sync endpoint

**Files:**
- Modify: `src/routes/admin.ts`
- Modify: `src/routes/admin.test.ts`

- [ ] **Step 1: Read the existing admin test file**

Read `src/routes/admin.test.ts` to understand its mock patterns, DB setup, and how auth bypass works. Note the `BYPASS_LOCAL_AUTH: 'true'` pattern for test bindings.

- [ ] **Step 2: Write tests for paginated sync endpoint**

Add to `src/routes/admin.test.ts`:

```typescript
describe('POST /sync/fastly (paginated)', () => {
  it('should return first page of users with cursor', async () => {
    // Seed 3 active users with pubkeys
    for (let i = 1; i <= 3; i++) {
      await db.prepare(
        `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 'self-service', ?, ?)`
      ).bind(`user${i}`, `user${i}`, `pk${i}`, 1000 + i, 1000 + i).run()
    }

    const req = new Request('https://names.admin.divine.video/api/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2, dry_run: true }),
    })

    const res = await app.fetch(req, testEnv, testCtx)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.synced).toBe(2)
    expect(data.cursor).toBeTruthy()
    expect(data.remaining).toBe(1)
  })

  it('should return null cursor on last page', async () => {
    await db.prepare(
      `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
       VALUES ('only', 'only', 'pk1', 'active', 'self-service', 1000, 1000)`
    ).run()

    const req = new Request('https://names.admin.divine.video/api/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10, dry_run: true }),
    })

    const res = await app.fetch(req, testEnv, testCtx)
    const data = await res.json()

    expect(data.ok).toBe(true)
    expect(data.cursor).toBeNull()
    expect(data.remaining).toBe(0)
  })

  it('should not call Fastly API in dry_run mode', async () => {
    await db.prepare(
      `INSERT INTO usernames (name, username_canonical, pubkey, status, claim_source, created_at, updated_at)
       VALUES ('alice', 'alice', 'pk1', 'active', 'self-service', 1000, 1000)`
    ).run()

    const req = new Request('https://names.admin.divine.video/api/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    })

    const res = await app.fetch(req, testEnv, testCtx)
    const data = await res.json()

    expect(data.ok).toBe(true)
    expect(data.synced).toBe(1)
    const { syncBatch } = await import('../utils/fastly-sync')
    expect(vi.mocked(syncBatch)).not.toHaveBeenCalled()
  })

  it('should return 400 when Fastly config is missing', async () => {
    const envNoFastly = { ...testEnv, FASTLY_API_TOKEN: undefined, FASTLY_STORE_ID: undefined }
    const req = new Request('https://names.admin.divine.video/api/admin/sync/fastly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    const res = await app.fetch(req, envNoFastly, testCtx)
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.ok).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: Tests fail — endpoint still uses old non-paginated logic

- [ ] **Step 4: Refactor the `/sync/fastly` endpoint in `src/routes/admin.ts`**

Update the import at the top of `src/routes/admin.ts`:

```typescript
import { syncUsernameToFastly, deleteUsernameFromFastly, syncBatch, type SyncItem } from '../utils/fastly-sync'
```

Add the `getActiveUsernamesPaginated` import:

```typescript
import { ..., getActiveUsernamesPaginated } from '../db/queries'
```

Replace the existing `/sync/fastly` endpoint (around line 660):

```typescript
admin.post('/sync/fastly', async (c) => {
  try {
    if (!c.env.FASTLY_API_TOKEN || !c.env.FASTLY_STORE_ID) {
      return c.json({ ok: false, error: 'Fastly credentials not configured' }, 400)
    }

    const body = await c.req.json<{
      limit?: number
      cursor?: string | null
      dry_run?: boolean
    }>().catch(() => ({}))

    const limit = Math.min(body.limit ?? 500, 1000)
    const afterId = body.cursor ? parseInt(body.cursor, 10) : null
    const dryRun = body.dry_run ?? false

    if (afterId !== null && isNaN(afterId)) {
      return c.json({ ok: false, error: 'Invalid cursor' }, 400)
    }

    const page = await getActiveUsernamesPaginated(c.env.DB, afterId, limit)

    const withPubkey = page.filter(u => u.pubkey)
    const nextCursor = page.length === limit ? String(page[page.length - 1].id) : null

    // Count remaining for progress reporting
    let remaining = 0
    if (nextCursor) {
      const countResult = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM usernames WHERE status = ? AND id > ?'
      ).bind('active', parseInt(nextCursor, 10)).first<{ count: number }>()
      remaining = countResult?.count ?? 0
    }

    if (dryRun) {
      return c.json({
        ok: true,
        synced: withPubkey.length,
        deleted: 0,
        failed: 0,
        cursor: nextCursor,
        remaining,
        dry_run: true,
      })
    }

    const items: SyncItem[] = withPubkey.map(u => ({
      username: u.username_canonical || u.name,
      action: 'sync' as const,
      data: {
        pubkey: u.pubkey!,
        relays: u.relays ? (() => { try { return JSON.parse(u.relays!) } catch { return [] } })() : [],
        status: 'active' as const,
        atproto_did: u.atproto_did || null,
        atproto_state: u.atproto_state || null,
      },
    }))

    const results = await syncBatch(c.env, items, { concurrency: 10 })

    return c.json({
      ok: true,
      synced: results.synced,
      deleted: results.deleted,
      failed: results.failed,
      cursor: nextCursor,
      remaining,
      errors: results.errors.length > 0 ? results.errors.slice(0, 20) : undefined,
    })
  } catch (error) {
    console.error('Fastly sync error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})
```

- [ ] **Step 5: Add `syncBatch` to the Fastly sync mock**

In `src/routes/admin.test.ts`, update the mock for `../utils/fastly-sync`:

```typescript
vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true }),
  bulkSyncToFastly: vi.fn().mockResolvedValue({ success: 0, failed: 0, errors: [] }),
  syncBatch: vi.fn().mockResolvedValue({ synced: 0, deleted: 0, failed: 0, errors: [] }),
}))
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin.ts src/routes/admin.test.ts src/db/queries.ts
git commit -m "feat: paginated Fastly KV full-sync endpoint with dry-run support"
```

---

### Task 6: CLI backfill script

**Files:**
- Create: `scripts/backfill-fastly-kv.sh`

- [ ] **Step 1: Create the backfill script**

Create `scripts/backfill-fastly-kv.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Backfill Fastly KV store by paging through the admin sync API.
# Usage:
#   ./scripts/backfill-fastly-kv.sh --dry-run
#   ./scripts/backfill-fastly-kv.sh --apply
#   ./scripts/backfill-fastly-kv.sh --apply --limit=1000
#
# Environment:
#   ADMIN_TOKEN  - CF Access service token or Keycast session JWT (required)
#   API_BASE     - Admin API base URL (default: https://names.admin.divine.video)

API_BASE="${API_BASE:-https://names.admin.divine.video}"
LIMIT=500
MODE=""
CURSOR="null"
TOTAL_SYNCED=0
TOTAL_FAILED=0
PAGE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)  MODE="dry_run" ;;
    --apply)    MODE="apply" ;;
    --limit=*)  LIMIT="${arg#*=}" ;;
    *)          echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Usage: $0 --dry-run | --apply [--limit=N]"
  echo ""
  echo "  --dry-run   Report what would be synced without writing to Fastly"
  echo "  --apply     Sync for real"
  echo "  --limit=N   Users per page (default: 500, max: 1000)"
  exit 1
fi

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "Error: ADMIN_TOKEN environment variable is required"
  echo "Set it to a CF Access service token or Keycast session JWT"
  exit 1
fi

DRY_RUN="false"
if [ "$MODE" = "dry_run" ]; then
  DRY_RUN="true"
  echo "=== DRY RUN MODE (no writes to Fastly) ==="
else
  echo "=== APPLY MODE (writing to Fastly KV) ==="
fi
echo "API: $API_BASE"
echo "Limit: $LIMIT per page"
echo ""

while true; do
  PAGE=$((PAGE + 1))

  if [ "$CURSOR" = "null" ]; then
    BODY=$(printf '{"limit":%s,"dry_run":%s}' "$LIMIT" "$DRY_RUN")
  else
    BODY=$(printf '{"limit":%s,"cursor":"%s","dry_run":%s}' "$LIMIT" "$CURSOR" "$DRY_RUN")
  fi

  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Cookie: __session=${ADMIN_TOKEN}" \
    -H "Cf-Access-Jwt-Assertion: ${ADMIN_TOKEN}" \
    -d "$BODY" \
    "${API_BASE}/api/admin/sync/fastly")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    echo "Error: HTTP $HTTP_CODE"
    echo "$BODY_RESPONSE"
    exit 1
  fi

  OK=$(echo "$BODY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
  if [ "$OK" != "True" ]; then
    echo "Error: API returned ok=false"
    echo "$BODY_RESPONSE"
    exit 1
  fi

  SYNCED=$(echo "$BODY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('synced', 0))")
  FAILED=$(echo "$BODY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failed', 0))")
  REMAINING=$(echo "$BODY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('remaining', 0))")
  CURSOR=$(echo "$BODY_RESPONSE" | python3 -c "import sys,json; c=json.load(sys.stdin).get('cursor'); print(c if c else 'null')")

  TOTAL_SYNCED=$((TOTAL_SYNCED + SYNCED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  ESTIMATED_PAGES="?"
  if [ "$PAGE" -eq 1 ] && [ "$REMAINING" -gt 0 ]; then
    ESTIMATED_PAGES=$(( (REMAINING + SYNCED + LIMIT - 1) / LIMIT ))
  fi

  echo "Page ${PAGE}: ${SYNCED} synced, ${FAILED} failed, ${REMAINING} remaining"

  if [ "$CURSOR" = "null" ]; then
    break
  fi
done

echo ""
echo "=== COMPLETE ==="
echo "Pages:  $PAGE"
echo "Synced: $TOTAL_SYNCED"
echo "Failed: $TOTAL_FAILED"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/backfill-fastly-kv.sh`

- [ ] **Step 3: Verify the script parses correctly**

Run: `bash -n scripts/backfill-fastly-kv.sh`
Expected: No output (syntax OK)

Run: `./scripts/backfill-fastly-kv.sh`
Expected: Usage message printed

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-fastly-kv.sh
git commit -m "feat: add CLI backfill script for Fastly KV sync"
```

---

### Task 7: Admin UI — Sync to Fastly button

**Files:**
- Modify: `admin-ui/src/types/index.ts`
- Modify: `admin-ui/src/api/client.ts`
- Modify: `admin-ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add the response type**

Add to `admin-ui/src/types/index.ts`:

```typescript
export interface FastlySyncPageResponse extends ApiResponse {
  synced: number
  deleted: number
  failed: number
  cursor: string | null
  remaining: number
  dry_run?: boolean
  errors?: string[]
}
```

- [ ] **Step 2: Add the API client function**

Add to `admin-ui/src/api/client.ts`:

```typescript
import type {
  // ... existing imports ...
  FastlySyncPageResponse
} from '../types'

export async function syncFastlyPage(
  options: { limit?: number; cursor?: string | null; dry_run?: boolean } = {}
): Promise<FastlySyncPageResponse> {
  const response = await fetch(`${API_BASE}/sync/fastly`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit: options.limit ?? 500,
      cursor: options.cursor ?? undefined,
      dry_run: options.dry_run ?? false,
    }),
  })

  if (!response.ok) {
    throw new Error(`Sync failed: ${response.statusText}`)
  }

  return response.json()
}
```

- [ ] **Step 3: Add the sync button to Dashboard.tsx**

Add the import at the top of `admin-ui/src/pages/Dashboard.tsx`:

```typescript
import { searchUsernames, getAllTags, syncFastlyPage } from '../api/client'
```

Add state variables inside the `Dashboard` component, after the existing state declarations:

```typescript
const [syncInProgress, setSyncInProgress] = useState(false)
const [syncProgress, setSyncProgress] = useState<{ synced: number; total: number; failed: number } | null>(null)
const [syncError, setSyncError] = useState<string | null>(null)
const [syncCancelled, setSyncCancelled] = useState(false)
```

Add the sync handler function inside the component, after `performSearch`:

```typescript
const handleSyncFastly = useCallback(async () => {
  if (!window.confirm('This will sync all active usernames to Fastly KV. This may take several minutes. Continue?')) {
    return
  }

  setSyncInProgress(true)
  setSyncProgress(null)
  setSyncError(null)
  setSyncCancelled(false)

  let cursor: string | null = null
  let totalSynced = 0
  let totalFailed = 0
  let cancelled = false

  try {
    // First call to get total count
    const dryRun = await syncFastlyPage({ limit: 1, dry_run: true })
    const estimatedTotal = (dryRun.remaining ?? 0) + (dryRun.synced ?? 0)

    while (!cancelled) {
      const result = await syncFastlyPage({ cursor, limit: 500 })
      totalSynced += result.synced
      totalFailed += result.failed
      setSyncProgress({ synced: totalSynced, total: estimatedTotal, failed: totalFailed })

      if (!result.cursor) break
      cursor = result.cursor

      // Check cancellation via ref trick
      if (syncCancelled) {
        cancelled = true
      }
    }

    if (cancelled) {
      setSyncError(`Sync cancelled. ${totalSynced} synced, ${totalFailed} failed so far.`)
    }
  } catch (err) {
    setSyncError(err instanceof Error ? err.message : 'Sync failed')
  } finally {
    setSyncInProgress(false)
  }
}, [syncCancelled])
```

Add the UI after the CSV Export section (after the closing `</div>` of the CSV section, before the `{error &&` block). In `Dashboard.tsx`, insert after line 231:

```tsx
{/* Fastly KV Sync */}
<div className="mt-4 pt-4 border-t border-gray-200">
  <div className="flex items-center gap-4">
    <div>
      <p className="text-sm font-medium text-gray-700">Fastly KV Sync</p>
      <p className="text-xs text-gray-500">Sync all active usernames to Fastly edge for NIP-05 resolution</p>
    </div>
    {!syncInProgress ? (
      <button
        type="button"
        onClick={handleSyncFastly}
        className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-blue-100 text-blue-700 hover:bg-blue-200"
      >
        Sync to Fastly KV
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setSyncCancelled(true)}
        className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-red-100 text-red-700 hover:bg-red-200"
      >
        Cancel
      </button>
    )}
  </div>
  {syncProgress && (
    <div className="mt-2">
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <div className="flex-1 bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all"
            style={{ width: `${syncProgress.total > 0 ? Math.min(100, (syncProgress.synced / syncProgress.total) * 100) : 0}%` }}
          />
        </div>
        <span className="whitespace-nowrap">
          {syncProgress.synced.toLocaleString()} / {syncProgress.total.toLocaleString()}
          {syncProgress.failed > 0 && <span className="text-red-600"> ({syncProgress.failed} failed)</span>}
        </span>
      </div>
    </div>
  )}
  {syncError && (
    <p className="mt-2 text-sm text-red-600">{syncError}</p>
  )}
</div>
```

- [ ] **Step 4: Build admin UI to verify no compile errors**

Run: `cd admin-ui && npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/types/index.ts admin-ui/src/api/client.ts admin-ui/src/pages/Dashboard.tsx
git commit -m "feat: add Sync to Fastly KV button in admin dashboard"
```

---

### Task 8: Clean up and remove dead code

**Files:**
- Modify: `src/utils/fastly-sync.ts`
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Check if `bulkSyncToFastly` is still used anywhere**

Run: `grep -rn 'bulkSyncToFastly' src/`

If it's only imported in `admin.ts` and used nowhere (replaced by `syncBatch`), remove it.

- [ ] **Step 2: Remove `bulkSyncToFastly` from `fastly-sync.ts` if unused**

Delete the `bulkSyncToFastly` function from `src/utils/fastly-sync.ts` (lines 137-154).

- [ ] **Step 3: Remove `bulkSyncToFastly` import from `admin.ts` if unused**

Update the import in `src/routes/admin.ts` to remove `bulkSyncToFastly`.

- [ ] **Step 4: Remove `getAllActiveUsernames` import from `admin.ts` if no longer used**

Check: `grep -n 'getAllActiveUsernames' src/routes/admin.ts`

If still used by another endpoint (e.g., export), keep it. If only the old sync endpoint used it, remove the import.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/utils/fastly-sync.ts src/routes/admin.ts
git commit -m "chore: remove unused bulkSyncToFastly after syncBatch migration"
```

---

### Task 9: Final integration test and PR update

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Type check the entire project**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build admin UI**

Run: `cd admin-ui && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Squash the WIP commit into the feature commits**

The first commit on this branch was a WIP. Squash it into the relevant feature commit:

Run: `git log --oneline` to see all commits on the branch, then interactive rebase to squash the WIP into the first feature commit.

- [ ] **Step 5: Push and update PR #44**

Push the branch and update the PR description to reflect the completed implementation.

```bash
git push --force-with-lease origin fix/cron-sync-scaling
```

Update PR body via `gh pr edit 44` with the final summary covering all 5 components.
