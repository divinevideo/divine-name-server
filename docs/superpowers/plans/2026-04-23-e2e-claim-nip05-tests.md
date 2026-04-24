# E2E Claim → NIP-05 Resolution Test Coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add route-level tests that exercise the full claim → NIP-05 resolution path, proving that a claimed username resolves correctly via `/.well-known/nostr.json` and that the `revoked_at` bug from PR #35 stays fixed.

**Architecture:** Mount both the username route (`/api/username`) and the NIP-05 route (`/.well-known/nostr.json`) on a single test Hono app. Upgrade `createMockDB` in `username.test.ts` to track `revoked_at` mutations faithfully on the ON CONFLICT path (the same technique used by `createStatefulMockDB` in `queries.test.ts`). Each test scenario claims a name via HTTP POST, then queries NIP-05 via HTTP GET on the same app to verify resolution.

**Tech Stack:** Vitest, Hono, existing mock infrastructure

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/routes/claim-nip05.e2e.test.ts` | End-to-end tests: claim → NIP-05 resolution |

The new file keeps e2e tests separate from the existing unit/route tests in `username.test.ts`. It imports the existing `createMockDB` from `username.test.ts` would be an option, but since that function is not exported and modifying it would risk breaking existing tests, we'll define a self-contained mock DB in the new test file that correctly handles the two-step revoke+upsert flow.

---

### Task 1: Create e2e test scaffold with mock DB

**Files:**
- Create: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Create the test file with imports, mocks, and mock DB**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import username from './username'
import nip05 from './nip05'

vi.mock('../middleware/nip98', () => ({
  verifyNip98Event: vi.fn()
}))

vi.mock('../utils/email', () => ({
  sendReservationConfirmationEmail: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../utils/fastly-sync', () => ({
  syncUsernameToFastly: vi.fn().mockResolvedValue({ success: true }),
  deleteUsernameFromFastly: vi.fn().mockResolvedValue({ success: true })
}))

type MockUsername = {
  id: number
  name: string
  username_display: string
  username_canonical: string
  pubkey: string | null
  relays: string | null
  status: string
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
  email: string | null
  reservation_email: string | null
  confirmation_token: string | null
  reservation_expires_at: number | null
  subscription_expires_at: number | null
  claim_source: string | null
  created_by: string | null
  atproto_did: string | null
  atproto_state: string | null
}

/**
 * Stateful mock D1 that faithfully simulates the two-step claim flow:
 *   Step 1: UPDATE ... SET status='revoked', revoked_at=? WHERE pubkey=? AND status='active'
 *   Step 2: INSERT ... ON CONFLICT(username_canonical) DO UPDATE SET ... revoked_at = NULL
 *
 * The ON CONFLICT handler checks whether the SQL contains 'revoked_at = NULL'.
 * If the fix from PR #35 is reverted, revoked_at will NOT be cleared and tests will fail.
 */
function createE2EMockDB(initialUsernames: Partial<MockUsername>[] = []) {
  const mockUsernames: MockUsername[] = initialUsernames.map((u, i) => ({
    id: u.id ?? i + 1,
    name: u.name ?? u.username_canonical ?? '',
    username_display: u.username_display ?? u.name ?? u.username_canonical ?? '',
    username_canonical: u.username_canonical ?? u.name ?? '',
    pubkey: u.pubkey ?? null,
    relays: u.relays ?? null,
    status: u.status ?? 'active',
    recyclable: u.recyclable ?? 1,
    created_at: u.created_at ?? 1700000000,
    updated_at: u.updated_at ?? 1700000000,
    claimed_at: u.claimed_at ?? 1700000000,
    revoked_at: u.revoked_at ?? null,
    reserved_reason: u.reserved_reason ?? null,
    admin_notes: u.admin_notes ?? null,
    email: u.email ?? null,
    reservation_email: u.reservation_email ?? null,
    confirmation_token: u.confirmation_token ?? null,
    reservation_expires_at: u.reservation_expires_at ?? null,
    subscription_expires_at: u.subscription_expires_at ?? null,
    claim_source: u.claim_source ?? null,
    created_by: u.created_by ?? null,
    atproto_did: u.atproto_did ?? null,
    atproto_state: u.atproto_state ?? null,
  }))

  return {
    _mockUsernames: mockUsernames,
    prepare: (sql: string) => {
      let boundParams: any[] = []
      return {
        bind: (...params: any[]) => {
          boundParams = params
          return {
            first: async () => {
              if (sql.includes('COUNT(*)') && sql.includes('usernames')) {
                return { count: 0 }
              }
              if (sql.includes('reserved_words')) {
                return null
              }
              if (sql.includes('username_canonical = ?') || sql.includes('name = ?')) {
                const lookupValue = boundParams[0] || boundParams[1]
                return mockUsernames.find(u =>
                  u.username_canonical === lookupValue || u.name === lookupValue
                ) || null
              }
              if (sql.includes('pubkey = ?') && sql.includes('status')) {
                const pubkey = boundParams[0]
                return mockUsernames.find(u => u.pubkey === pubkey && u.status === 'active') || null
              }
              return null
            },
            all: async () => ({ results: [] }),
            run: async () => {
              // Step 1: Revoke active username for pubkey
              if (sql.includes("SET status = 'revoked'") && sql.includes('WHERE pubkey = ?')) {
                const revokedAt = boundParams[0]
                const updatedAt = boundParams[1]
                const pubkey = boundParams[2]
                for (const u of mockUsernames) {
                  if (u.pubkey === pubkey && u.status === 'active') {
                    u.status = 'revoked'
                    u.revoked_at = revokedAt
                    u.updated_at = updatedAt
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Admin revoke: SET status = ?, recyclable = ?, revoked_at = ?
              if (sql.includes('SET status = ?') && sql.includes('recyclable = ?') && sql.includes('revoked_at = ?')) {
                const status = boundParams[0]
                const recyclable = boundParams[1]
                const revokedAt = boundParams[2]
                const updatedAt = boundParams[3]
                const canonical = boundParams[4]
                const name = boundParams[5]
                for (const u of mockUsernames) {
                  if (u.username_canonical === canonical || u.name === name) {
                    u.status = status
                    u.recyclable = recyclable
                    u.revoked_at = revokedAt
                    u.updated_at = updatedAt
                  }
                }
                return { success: true, meta: { changes: 1 } }
              }

              // Step 2: INSERT ... ON CONFLICT
              if (sql.includes('INSERT INTO usernames') && sql.includes('ON CONFLICT')) {
                const display = boundParams[1]
                const canonical = boundParams[2]
                const pubkey = boundParams[3]
                const now = boundParams[boundParams.length - 1]

                const existing = mockUsernames.find(u => u.username_canonical === canonical)
                if (existing) {
                  existing.name = canonical
                  existing.username_display = display
                  existing.pubkey = pubkey
                  existing.status = 'active'
                  existing.updated_at = now
                  existing.claimed_at = now
                  // Critical: only clear revoked_at if SQL contains the fix
                  if (sql.includes('revoked_at = NULL')) {
                    existing.revoked_at = null
                  }
                } else {
                  mockUsernames.push({
                    id: mockUsernames.length + 1,
                    name: canonical,
                    username_display: display,
                    username_canonical: canonical,
                    pubkey: pubkey,
                    relays: boundParams[4] || null,
                    status: 'active',
                    recyclable: 1,
                    created_at: now,
                    updated_at: now,
                    claimed_at: now,
                    revoked_at: null,
                    reserved_reason: null,
                    admin_notes: null,
                    email: null,
                    reservation_email: null,
                    confirmation_token: null,
                    reservation_expires_at: null,
                    subscription_expires_at: null,
                    claim_source: 'self-service',
                    created_by: null,
                    atproto_did: null,
                    atproto_state: null,
                  })
                }
              }
              return { success: true, meta: { changes: 1 } }
            }
          }
        }
      }
    }
  } as unknown as D1Database & { _mockUsernames: MockUsername[] }
}

function createTestApp() {
  const app = new Hono<{ Bindings: { DB: D1Database } }>()
  app.route('/api/username', username)
  app.route('', nip05)
  return app
}

const mockEnv = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
```

- [ ] **Step 2: Run the test file to verify it loads without errors**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 0 tests found, no import/syntax errors.

- [ ] **Step 3: Commit scaffold**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: scaffold e2e claim→NIP-05 test file with stateful mock DB"
```

---

### Task 2: Claim a name, verify NIP-05 resolves

**Files:**
- Modify: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Write the test**

Add inside a `describe('Claim → NIP-05 resolution (e2e)', () => { ... })` block:

```typescript
describe('Claim → NIP-05 resolution (e2e)', () => {
  let verifyNip98Event: any

  beforeEach(async () => {
    const nip98Module = await import('../middleware/nip98')
    verifyNip98Event = nip98Module.verifyNip98Event
    vi.mocked(verifyNip98Event).mockResolvedValue('a'.repeat(64))
  })

  it('claim a name, then NIP-05 resolves to the pubkey', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    // Claim "alice"
    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    const claimRes = await app.fetch(claimReq, { DB: db }, mockEnv)
    expect(claimRes.status).toBe(200)

    // NIP-05 root domain: /.well-known/nostr.json?name=alice
    const nip05Req = new Request('http://localhost/.well-known/nostr.json?name=alice')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names.alice).toBe(pubkey)
  })
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 1 test, PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: e2e claim→NIP-05 resolution for fresh name"
```

---

### Task 3: Re-claim same name, verify revoked_at is null

**Files:**
- Modify: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
  it('re-claim same name clears revoked_at and NIP-05 still resolves', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    // First claim
    const claim1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    await app.fetch(claim1, { DB: db }, mockEnv)

    // Second claim — same pubkey, same name (mobile double-fire scenario)
    const claim2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    const res2 = await app.fetch(claim2, { DB: db }, mockEnv)
    expect(res2.status).toBe(200)

    // DB record should have revoked_at = null
    const record = db._mockUsernames.find(u => u.username_canonical === 'alice')
    expect(record).toBeDefined()
    expect(record!.status).toBe('active')
    expect(record!.revoked_at).toBeNull()

    // NIP-05 still resolves
    const nip05Req = new Request('http://localhost/.well-known/nostr.json?name=alice')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names.alice).toBe(pubkey)
  })
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 2 tests, PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: e2e re-claim same name clears revoked_at"
```

---

### Task 4: Switch names, verify old name stops resolving

**Files:**
- Modify: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
  it('switch names: old name stops resolving, new name resolves', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    // Claim "alice"
    const claim1 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' })
    })
    const res1 = await app.fetch(claim1, { DB: db }, mockEnv)
    expect(res1.status).toBe(200)

    // Claim "bob" (same pubkey — triggers Step 1 revoke of "alice")
    const claim2 = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob' })
    })
    const res2 = await app.fetch(claim2, { DB: db }, mockEnv)
    expect(res2.status).toBe(200)

    // "alice" should be revoked — NIP-05 returns empty
    const nip05Alice = new Request('http://localhost/.well-known/nostr.json?name=alice')
    const aliceRes = await app.fetch(nip05Alice, { DB: db }, mockEnv)
    expect(aliceRes.status).toBe(200)
    const aliceJson = await aliceRes.json() as any
    expect(aliceJson.names).toEqual({})

    // "bob" resolves
    const nip05Bob = new Request('http://localhost/.well-known/nostr.json?name=bob')
    const bobRes = await app.fetch(nip05Bob, { DB: db }, mockEnv)
    expect(bobRes.status).toBe(200)
    const bobJson = await bobRes.json() as any
    expect(bobJson.names.bob).toBe(pubkey)
  })
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 3 tests, PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: e2e name switch revokes old, resolves new"
```

---

### Task 5: Claim a previously-revoked name

**Files:**
- Modify: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
  it('claim a revoked name: NIP-05 resolves to new pubkey, revoked_at is null', async () => {
    const app = createTestApp()
    const revokedAt = 1700000500
    const db = createE2EMockDB([{
      name: 'charlie', username_canonical: 'charlie', username_display: 'charlie',
      pubkey: 'b'.repeat(64), status: 'revoked', revoked_at: revokedAt, recyclable: 1,
    }])
    const newPubkey = 'c'.repeat(64)
    vi.mocked((await import('../middleware/nip98')).verifyNip98Event).mockResolvedValue(newPubkey)

    // Claim "charlie" with a different pubkey
    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'charlie' })
    })
    const claimRes = await app.fetch(claimReq, { DB: db }, mockEnv)
    expect(claimRes.status).toBe(200)

    // DB record: revoked_at cleared, status active
    const record = db._mockUsernames.find(u => u.username_canonical === 'charlie')
    expect(record!.status).toBe('active')
    expect(record!.revoked_at).toBeNull()
    expect(record!.pubkey).toBe(newPubkey)

    // NIP-05 resolves to new pubkey
    const nip05Req = new Request('http://localhost/.well-known/nostr.json?name=charlie')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names.charlie).toBe(newPubkey)
  })
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 4 tests, PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: e2e claim revoked name clears revoked_at, resolves to new pubkey"
```

---

### Task 6: Fastly KV sync receives correct data

**Files:**
- Modify: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
  it('Fastly KV sync called with status:active after claim', async () => {
    const { syncUsernameToFastly, deleteUsernameFromFastly } = await import('../utils/fastly-sync')
    vi.mocked(syncUsernameToFastly).mockClear()
    vi.mocked(deleteUsernameFromFastly).mockClear()

    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)
    const waitUntilPromises: Promise<any>[] = []

    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dave' })
    })
    await app.fetch(claimReq, { DB: db }, {
      waitUntil: (p: Promise<any>) => { waitUntilPromises.push(p) },
      passThroughOnException: () => {},
      props: {}
    })

    expect(syncUsernameToFastly).toHaveBeenCalledWith(
      expect.objectContaining({}),
      'dave',
      expect.objectContaining({
        pubkey,
        status: 'active',
      })
    )
  })
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 5 tests, PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: e2e verify Fastly KV sync receives status:active"
```

---

### Task 7: Subdomain NIP-05 resolution

**Files:**
- Modify: `src/routes/claim-nip05.e2e.test.ts`

- [ ] **Step 1: Write the test**

The NIP-05 route also handles subdomain-style lookups at `alice.divine.video/.well-known/nostr.json`. This is an important production path. Add a test that verifies it works after claiming.

```typescript
  it('subdomain NIP-05 resolves after claim', async () => {
    const app = createTestApp()
    const db = createE2EMockDB()
    const pubkey = 'a'.repeat(64)

    // Claim "eve"
    const claimReq = new Request('http://localhost/api/username/claim', {
      method: 'POST',
      headers: { 'Authorization': 'Nostr base64...', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'eve' })
    })
    await app.fetch(claimReq, { DB: db }, mockEnv)

    // Subdomain NIP-05: eve.divine.video/.well-known/nostr.json (no ?name param)
    const nip05Req = new Request('http://eve.divine.video/.well-known/nostr.json')
    const nip05Res = await app.fetch(nip05Req, { DB: db }, mockEnv)
    expect(nip05Res.status).toBe(200)
    const json = await nip05Res.json() as any
    expect(json.names['_']).toBe(pubkey)
  })
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/code/divine-name-server && npx vitest run src/routes/claim-nip05.e2e.test.ts`
Expected: 6 tests, PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/claim-nip05.e2e.test.ts
git commit -m "test: e2e subdomain NIP-05 resolution after claim"
```

---

### Task 8: Run full test suite, verify no regressions

**Files:**
- None modified

- [ ] **Step 1: Run the full test suite**

Run: `cd ~/code/divine-name-server && npx vitest run`
Expected: All existing tests pass. New e2e tests pass. 0 failures.

- [ ] **Step 2: Verify test count increased**

The test output should show 6 new tests in `claim-nip05.e2e.test.ts` on top of existing tests in `username.test.ts` and `queries.test.ts`.

- [ ] **Step 3: Final commit if any cleanup needed**

If any imports or formatting adjustments were needed, commit them:

```bash
git add -A
git commit -m "test: finalize e2e claim→NIP-05 test suite"
```
