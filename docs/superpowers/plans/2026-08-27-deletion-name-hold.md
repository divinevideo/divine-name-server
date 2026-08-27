# Deletion Name Hold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On account-deletion finalize, a released `@divine.video` name is held
for one year (not permanently burned), stops resolving immediately, is
un-claimable during the hold, then returns to circulation; reserved-origin
names return to the reserve; the deleted owner's pubkey is cleared.

**Architecture:** Change the terminal state of the existing coordinator-driven
`finalizeReleaseAttempt` from `burned` to a branch (`held` or `reserved`),
clear `pubkey`, write an append-only breadcrumb row, and add an hourly cron
sweep that returns expired holds to the claimable `revoked` state. No claim,
resolution, or coordinator-contract changes. No funnelcake change.

**Tech Stack:** TypeScript, Hono, Cloudflare Worker, D1 (SQLite), Vitest.
Real-SQLite tests via `node:sqlite` (Node 22.5+); a hand-rolled fake-D1 for
older runtimes.

**Spec:** `docs/superpowers/specs/2026-08-27-deletion-name-hold-design.md`

## Global Constraints

- **No CI test gate in this repo.** `deploy.yml` only deploys on push to `main`;
  it runs no tests. `npm run test:once` and `npm run typecheck` locally are the
  guard (AGENTS.md: run checks before requesting review). Both the real-SQLite
  suite and the fake-D1 suite run locally on Node 22.5+ — **both must stay
  green.**
- Conventional-commit PR title; keep the PR tightly scoped (no drive-by
  refactors); PR body needs summary, motivation, linked issue, manual
  validation plan (AGENTS.md).
- Never truncate or log a pubkey; never log auth material.
- The coordinator HTTP contract (`POST /api/internal/username/release/finalize`)
  is unchanged. The `burned` status remains the admin permanent-kill path.
- Reviewer callouts (from the spec) ride in the PR description: (1) `pubkey`
  cleared on finalize; (2) the pubkey-free breadcrumb table.

---

## Task 1: Schema foundation — breadcrumb table + `held` status

**Files:**
- Create: `migrations/0012_add_username_release_history.sql`
- Modify: `src/db/queries.ts` (add `held` to the three `status` unions; add the
  `UsernameReleaseHistoryRow` type)
- Modify: `src/routes/admin.ts:18` (`VALID_ADMIN_STATUSES`)
- Modify: `src/db/test-helpers.ts:9` (`USERNAME_STATUSES` in the fake)
- Test: `src/db/username-release-history-migration.test.ts` (new)

**Interfaces:**
- Produces: table `username_release_history (id, username_canonical, released_at, reason)`;
  `'held'` accepted as a `Username['status']` value.

- [ ] **Step 1: Write the failing migration test**

```typescript
// src/db/username-release-history-migration.test.ts
// ABOUTME: Verifies the deletion breadcrumb table exists after migrations.
import { describe, expect, it } from 'vitest'
import { createSqliteD1, sqliteAvailable } from './sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('username_release_history migration', () => {
  it('creates an append-only breadcrumb table with no pubkey column', () => {
    const { sqlite } = createSqliteD1()
    const columns = sqlite
      .prepare('PRAGMA table_info(username_release_history)')
      .all()
      .map((row) => (row as { name: string }).name)

    expect(columns).toEqual(
      expect.arrayContaining(['id', 'username_canonical', 'released_at', 'reason']),
    )
    expect(columns).not.toContain('pubkey')
  })
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run src/db/username-release-history-migration.test.ts`
Expected: FAIL — `no such table: username_release_history`.

- [ ] **Step 3: Add the migration**

```sql
-- migrations/0012_add_username_release_history.sql
-- ABOUTME: Append-only breadcrumb of deletion-driven name releases.
-- No pubkey: a completed deletion removes the identity. This records only that a
-- handle was released by deletion, so support can see that a reissued handle
-- previously belonged to a since-deleted account.
CREATE TABLE IF NOT EXISTS username_release_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_canonical TEXT NOT NULL,
  released_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_release_history_canonical
  ON username_release_history (username_canonical);
```

- [ ] **Step 4: Add `held` to the status unions + the history row type**

In `src/db/queries.ts`, add `| 'held'` to the `status` field of `interface
Username` (line 23), to `SearchParams.status` (line 55), and to the
`searchUsernames`/export status parameter union (~line 998). Add near the other
interfaces:

```typescript
export interface UsernameReleaseHistoryRow {
  id: number
  username_canonical: string
  released_at: number
  reason: string
}
```

In `src/routes/admin.ts:18`, add `'held'` to `VALID_ADMIN_STATUSES`.
In `src/db/test-helpers.ts:9`, add `'held'` to `USERNAME_STATUSES`.

- [ ] **Step 5: Run test + typecheck — expect pass**

Run: `npx vitest run src/db/username-release-history-migration.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add migrations/0012_add_username_release_history.sql src/db/queries.ts \
  src/routes/admin.ts src/db/test-helpers.ts \
  src/db/username-release-history-migration.test.ts
git commit -m "feat(deletion): add release-history table and held status"
```

---

## Task 2: Finalize releases to a hold (or reserve), clears pubkey, writes breadcrumb

**Files:**
- Modify: `src/db/queries.ts` — `finalizeReleaseAttempt` (lines 271-312)
- Test: `src/db/release-attempts-sqlite.test.ts` (real SQLite — rewrite the burn
  case, add held/reserved/idempotency/breadcrumb cases)
- Modify: `src/db/release-attempts.test.ts` (fake-D1 — update the finalize mock
  from `burned` to `held`)
- Modify: `src/routes/internal-deletion.test.ts:29` (fixture `status: 'burned'`
  → `'held'`; route asserts `state:'finalized'` only, so this is a
  fixture-accuracy update)

**Interfaces:**
- Consumes: `isReservedWord` (queries.ts:102), `getReleaseAttemptById`,
  `getUsernameByName`, `username_release_history` (Task 1).
- Produces: `finalizeReleaseAttempt` sets `held`/`reserved` + clears `pubkey`;
  returns the same `ReleaseTransitionResult` shape.

- [ ] **Step 1: Rewrite the burn test to the held contract (RED)**

In `src/db/release-attempts-sqlite.test.ts`, replace the existing
`'finalizes to a non-recyclable burn that cannot be rolled back'` test with:

```typescript
  it('finalizes to a one-year hold, clears pubkey, and writes one breadcrumb', async () => {
    const { db, sqlite } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)).outcome).toBe('transitioned')
    const held = await getUsernameByName(db, 'alice')
    expect(held?.status).toBe('held')
    expect(held?.recyclable).toBe(0)
    expect(held?.pubkey).toBeNull()
    expect(held?.revoked_at).toBe(200)

    const history = sqlite
      .prepare('SELECT username_canonical, released_at, reason FROM username_release_history WHERE username_canonical = ?')
      .all('alice')
    expect(history).toEqual([{ username_canonical: 'alice', released_at: 200, reason: 'deletion' }])

    // A finalized attempt is terminal and cannot be rolled back.
    expect((await rollbackReleaseAttempt(db, OWNER, 'alice', ATTEMPT)).outcome).toBe('conflict')
  })

  it('replays finalize idempotently without a second breadcrumb', async () => {
    const { db, sqlite } = withOwnedName()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)
    await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 201)).outcome).toBe('replayed')
    const count = sqlite
      .prepare('SELECT COUNT(*) AS n FROM username_release_history WHERE username_canonical = ?')
      .get('alice') as { n: number }
    expect(count.n).toBe(1)
  })

  it('returns a reserved-origin name to the reserve with no hold or breadcrumb', async () => {
    const { db, sqlite } = withOwnedName()
    sqlite.prepare(`INSERT INTO reserved_words (word, category, reason, created_at) VALUES ('alice', 'brand', 'test', 100)`).run()
    await prepareReleaseAttempt(db, OWNER, 'alice', ATTEMPT, 999, 100)

    expect((await finalizeReleaseAttempt(db, ATTEMPT, 'coordinator', 200)).outcome).toBe('transitioned')
    const reserved = await getUsernameByName(db, 'alice')
    expect(reserved?.status).toBe('reserved')
    expect(reserved?.pubkey).toBeNull()

    const count = sqlite
      .prepare('SELECT COUNT(*) AS n FROM username_release_history WHERE username_canonical = ?')
      .get('alice') as { n: number }
    expect(count.n).toBe(0)
  })
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/db/release-attempts-sqlite.test.ts`
Expected: FAIL — current finalize sets `status='burned'`, keeps pubkey, writes
no breadcrumb.

- [ ] **Step 3: Rewrite `finalizeReleaseAttempt`**

Replace lines 271-312 of `src/db/queries.ts` with:

```typescript
/** Terminal status for a released (non-reserved) name: a one-year hold. */
const RELEASE_HOLD_STATUS = 'held'

export async function finalizeReleaseAttempt(
  db: D1Database,
  attemptId: string,
  finalizedBy: string,
  now = Math.floor(Date.now() / 1000)
): Promise<ReleaseTransitionResult> {
  const existing = await getReleaseAttemptById(db, attemptId)
  if (!existing) return { outcome: 'not_found' }
  const currentUsername = await getUsernameByName(db, existing.username_canonical)
  // A finalized attempt is terminal. Its downstream name status may since have
  // moved (held -> revoked after a year, or reissued to a new owner), so replay
  // keys on the attempt ledger, not the current name status.
  if (existing.state === 'finalized' && currentUsername) {
    return { outcome: 'replayed', attempt: existing, username: currentUsername }
  }
  if (existing.state !== 'pending') return { outcome: 'conflict', attempt: existing }
  if (existing.expires_at <= now) return { outcome: 'conflict', attempt: existing }

  // Reserved-origin names return to the reserve; everyone else enters the hold.
  const reserved = await isReservedWord(db, existing.username_canonical)
  const targetStatus = reserved ? 'reserved' : RELEASE_HOLD_STATUS

  // pubkey cleared on finalize so a held/reissued name carries no trace of the
  // deleted account (deletion policy 2026-08-27).
  const release = db.prepare(
    `UPDATE usernames
     SET status = ?, recyclable = 0, pubkey = NULL, revoked_at = ?, updated_at = ?
     WHERE username_canonical = ? AND LOWER(pubkey) = LOWER(?) AND status = 'pending-release'
       AND EXISTS (
         SELECT 1 FROM username_release_attempts
         WHERE attempt_id = ? AND state = 'pending' AND expires_at > ?
       )`
  ).bind(targetStatus, now, now, existing.username_canonical, existing.pubkey, attemptId, now)

  // Breadcrumb only for the hold path. Guarded on (name now at target) AND
  // (attempt still pending) so a racing second finalize cannot double-insert:
  // the first call flips the attempt to 'finalized' in this same batch below,
  // and any concurrent transaction sees that committed state.
  const recordHistory = db.prepare(
    `INSERT INTO username_release_history (username_canonical, released_at, reason)
     SELECT ?, ?, 'deletion'
     WHERE EXISTS (SELECT 1 FROM usernames WHERE username_canonical = ? AND status = ?)
       AND EXISTS (SELECT 1 FROM username_release_attempts WHERE attempt_id = ? AND state = 'pending')`
  ).bind(existing.username_canonical, now, existing.username_canonical, targetStatus, attemptId)

  const finishAttempt = db.prepare(
    `UPDATE username_release_attempts
     SET state = 'finalized', updated_at = ?, finalized_at = ?, finalized_by = ?
     WHERE attempt_id = ? AND state = 'pending'
       AND EXISTS (SELECT 1 FROM usernames WHERE username_canonical = ? AND status = ?)`
  ).bind(now, now, finalizedBy, attemptId, existing.username_canonical, targetStatus)

  const statements = reserved
    ? [release, finishAttempt]
    : [release, recordHistory, finishAttempt]
  const results = await db.batch(statements)
  const releaseResult = results[0]
  const attemptResult = results[results.length - 1]

  const attempt = await getReleaseAttemptById(db, attemptId)
  const username = await getUsernameByName(db, existing.username_canonical)
  if (!releaseResult.meta?.changes || !attemptResult.meta?.changes) {
    if (attempt?.state === 'finalized' && username) {
      return { outcome: 'replayed', attempt, username }
    }
    return { outcome: 'conflict', attempt: attempt || undefined }
  }
  if (!attempt || !username) return { outcome: 'conflict' }
  return { outcome: 'transitioned', attempt, username }
}
```

- [ ] **Step 4: Run the SQLite suite — expect pass**

Run: `npx vitest run src/db/release-attempts-sqlite.test.ts`
Expected: PASS (all cases, including the untouched prepare/rollback tests).

- [ ] **Step 5: Fix the fake-D1 finalize test (still-green on any Node)**

In `src/db/release-attempts.test.ts`, the hand-rolled mock matches
`sql.includes("SET status = 'burned'")` and asserts `status: 'burned'`. Update
the mock and assertion to the held path (the fake need not model the
reserved/breadcrumb branch — the SQLite suite covers those):

- Change the write matcher from `sql.includes("SET status = 'burned'")` to
  `sql.includes('SET status = ?')` and, inside it, set
  `username.status = 'held'; username.recyclable = 0; username.pubkey = null;`
  using the bound `revokedAt`/`updatedAt` params as before.
- Change the `finishAttempt` guard `username.status !== 'burned'` to
  `username.status !== 'held'`.
- Change the assertion `expect(username).toMatchObject({ status: 'burned', recyclable: 0 })`
  to `expect(username).toMatchObject({ status: 'held', recyclable: 0, pubkey: null })`.
- The fake's batch runner iterates statements; the new `INSERT INTO
  username_release_history` statement has no matching branch, so add a no-op
  branch (`if (sql.includes('username_release_history')) return { success: true, meta: { changes: 1 } }`)
  so the batch does not throw.

- [ ] **Step 6: Update the internal-deletion route fixture**

In `src/routes/internal-deletion.test.ts:29`, change
`const username = { username_canonical: 'alice', name: 'alice', status: 'burned' }`
to `status: 'held'`. The route only asserts `state:'finalized'`, so this is a
fixture-accuracy change; verify the file still passes.

- [ ] **Step 7: Run the affected suites — expect pass**

Run: `npx vitest run src/db/release-attempts.test.ts src/db/release-attempts-sqlite.test.ts src/routes/internal-deletion.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/queries.ts src/db/release-attempts-sqlite.test.ts \
  src/db/release-attempts.test.ts src/routes/internal-deletion.test.ts
git commit -m "feat(deletion): hold released names for a year instead of burning"
```

---

## Task 3: Cron sweep returns expired holds to circulation

**Files:**
- Modify: `src/db/queries.ts` (add `RELEASE_HOLD_SECONDS`, `expireHolds`)
- Modify: `src/index.ts` (import + call `expireHolds` in `scheduled`)
- Test: `src/db/expire-holds-sqlite.test.ts` (new, real SQLite)

**Interfaces:**
- Produces: `expireHolds(db, now?, holdSeconds?) => Promise<number>` — flips
  `held` rows past the window to `revoked` (recyclable=1); `RELEASE_HOLD_SECONDS`.

- [ ] **Step 1: Write the failing sweep test (RED)**

```typescript
// src/db/expire-holds-sqlite.test.ts
// ABOUTME: The cron sweep returns one-year-old holds to the claimable revoked state.
import { describe, expect, it } from 'vitest'
import { expireHolds, RELEASE_HOLD_SECONDS, getUsernameByName } from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

describe.skipIf(!sqliteAvailable())('expireHolds', () => {
  const NOW = 1_000_000_000

  function heldSince(revokedAt: number) {
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })
    sqlite.prepare('UPDATE usernames SET revoked_at = ? WHERE username_canonical = ?').run(revokedAt, 'alice')
    return { db }
  }

  it('leaves a hold that is one day short of a year untouched', async () => {
    const { db } = heldSince(NOW - RELEASE_HOLD_SECONDS + 86_400)
    expect(await expireHolds(db, NOW)).toBe(0)
    expect((await getUsernameByName(db, 'alice'))?.status).toBe('held')
  })

  it('returns a hold past one year to a claimable revoked row', async () => {
    const { db } = heldSince(NOW - RELEASE_HOLD_SECONDS - 86_400)
    expect(await expireHolds(db, NOW)).toBe(1)
    const cleared = await getUsernameByName(db, 'alice')
    expect(cleared?.status).toBe('revoked')
    expect(cleared?.recyclable).toBe(1)
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/db/expire-holds-sqlite.test.ts`
Expected: FAIL — `expireHolds` is not exported.

- [ ] **Step 3: Implement `expireHolds`**

Add to `src/db/queries.ts` (near `expireStaleReservations`):

```typescript
/** The one-year hold window before a released name returns to circulation. */
export const RELEASE_HOLD_SECONDS = 365 * 24 * 60 * 60

/**
 * Return holds whose one-year window has elapsed to a claimable `revoked` row
 * (the only status the claim path accepts). The `username_release_history`
 * breadcrumb is retained. Returns the number of names cleared.
 */
export async function expireHolds(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  holdSeconds = RELEASE_HOLD_SECONDS
): Promise<number> {
  const result = await db.prepare(
    `UPDATE usernames
     SET status = 'revoked', recyclable = 1, updated_at = ?
     WHERE status = 'held' AND revoked_at <= ?`
  ).bind(now, now - holdSeconds).run()
  return result.meta?.changes ?? 0
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/db/expire-holds-sqlite.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the cron**

In `src/index.ts`, add `expireHolds` to the `./db/queries` import (line 14), and
in `scheduled`, immediately after the `expireStaleReservations` block
(after line 114):

```typescript
    const clearedHolds = await expireHolds(env.DB)
    if (clearedHolds > 0) {
      console.log(`Cron: returned ${clearedHolds} expired name holds to circulation`)
    }
```

No Fastly action is needed at the transition: `held` and `revoked` both map to
KV-delete, and the existing `getUsernamesUpdatedSince` reconcile already covers
`revoked`.

- [ ] **Step 6: Typecheck + run — expect pass**

Run: `npm run typecheck && npx vitest run src/db/expire-holds-sqlite.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries.ts src/index.ts src/db/expire-holds-sqlite.test.ts
git commit -m "feat(deletion): expire one-year holds back to circulation via cron"
```

---

## Task 4: Pin the claim guard + reconcile backstop for `held`

**Files:**
- Modify: `src/db/queries.ts:432` (`getUsernamesUpdatedSince` — add `'held'`)
- Test: `src/db/claim-held-guard-sqlite.test.ts` (new, real SQLite)

**Interfaces:**
- Consumes: `claimUsername`, `expireHolds`, `getUsernameByName`.
- Produces: a regression test pinning "held is un-claimable; after expiry it is
  claimable"; the reconcile backstop now includes `held`.

- [ ] **Step 1: Write the failing guard/regression test (RED)**

```typescript
// src/db/claim-held-guard-sqlite.test.ts
// ABOUTME: Pins that a held name is un-claimable until its hold expires.
import { describe, expect, it } from 'vitest'
import { claimUsername, expireHolds, RELEASE_HOLD_SECONDS, getUsernameByName } from './queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from './sqlite-test-helpers'

const CLAIMANT = 'c'.repeat(64)

describe.skipIf(!sqliteAvailable())('held names and claim', () => {
  it('rejects claiming a held name, then allows it once the hold expires', async () => {
    const NOW = 2_000_000_000
    const { db, sqlite } = createSqliteD1()
    seedUsername(sqlite, { name: 'Alice', canonical: 'alice', pubkey: null, status: 'held', recyclable: 0 })
    sqlite.prepare('UPDATE usernames SET revoked_at = ? WHERE username_canonical = ?')
      .run(NOW - RELEASE_HOLD_SECONDS - 1, 'alice')

    await expect(claimUsername(db, 'Alice', 'alice', CLAIMANT, null)).rejects.toThrow('USERNAME_NOT_CLAIMABLE')

    expect(await expireHolds(db, NOW)).toBe(1)
    await claimUsername(db, 'Alice', 'alice', CLAIMANT, null)
    const claimed = await getUsernameByName(db, 'alice')
    expect(claimed?.status).toBe('active')
    expect(claimed?.pubkey?.toLowerCase()).toBe(CLAIMANT)
  })
})
```

- [ ] **Step 2: Run — expect pass on rejection, and pass overall**

Run: `npx vitest run src/db/claim-held-guard-sqlite.test.ts`
Expected: PASS — the claim allow-list already rejects `held` (no production
change needed for the guard); after `expireHolds` the row is `revoked` and the
claim succeeds. If this test does **not** pass, stop: the grounded assumption
that claim only accepts `revoked` is wrong and Task 2/3 need review.

> This is a characterization test guarding a grounded assumption. It fails only
> if a future change makes `held` claimable or breaks expiry, which is exactly
> the regression we want to catch.

- [ ] **Step 3: Add `held` to the reconcile backstop**

In `src/db/queries.ts:432`, change the `getUsernamesUpdatedSince` status filter
to include `'held'`:

```typescript
    `SELECT * FROM usernames WHERE updated_at >= ? AND status IN ('active', 'revoked', 'burned', 'pending-release', 'held')`
```

Rationale (inline as a short comment): finalize removes a held name from Fastly
immediately via `reconcileUsernameFastly`; including `held` here lets the
6-hour cron backstop re-affirm the KV delete if that immediate call failed and
the durable queue was lost.

- [ ] **Step 4: Run + typecheck — expect pass**

Run: `npm run typecheck && npx vitest run src/db/claim-held-guard-sqlite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts src/db/claim-held-guard-sqlite.test.ts
git commit -m "test(deletion): pin held un-claimable guard; add held reconcile backstop"
```

---

## Task 5: Admin operability — force-release + release-history lookup

> **Trim line.** This task is the operability surface for the hold. If the PR
> needs to shrink, it can ship in a focused follow-up; Tasks 1-4 are the
> complete behavioral feature. Admin-UI (React) wiring is out of scope for this
> PR — the Worker API here is what the SPA will later consume.

**Files:**
- Modify: `src/db/queries.ts` (`releaseHeldNameEarly`, `getUsernameReleaseHistory`)
- Modify: `src/routes/admin.ts` (two handlers, mirroring the `admin.get('/username/:name')`
  pattern at line 224 and its `UsernameValidationError` handling)
- Test: `src/routes/admin-release-history.test.ts` (new; mirror
  `src/routes/admin-release-guard.test.ts` harness)

**Interfaces:**
- Consumes: `createSqliteD1`, `seedUsername`, the admin auth middleware.
- Produces: `releaseHeldNameEarly(db, canonical, now?) => Promise<number>`;
  `getUsernameReleaseHistory(db, canonical) => Promise<UsernameReleaseHistoryRow[]>`;
  `GET /api/admin/username/:name/release-history`;
  `POST /api/admin/username/:name/release-hold`.

- [ ] **Step 1: Write failing query-fn tests (RED)**

```typescript
// src/routes/admin-release-history.test.ts
// ABOUTME: Admin force-release of a held name and release-history lookup.
import { describe, expect, it } from 'vitest'
import { releaseHeldNameEarly, getUsernameReleaseHistory, getUsernameByName } from '../db/queries'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'

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
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/routes/admin-release-history.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the query fns**

Add to `src/db/queries.ts`:

```typescript
/**
 * End a name's hold immediately (admin action), returning it to a claimable
 * `revoked` row. Returns the rows changed (0 when the name is not held).
 */
export async function releaseHeldNameEarly(
  db: D1Database,
  usernameCanonical: string,
  now = Math.floor(Date.now() / 1000)
): Promise<number> {
  const result = await db.prepare(
    `UPDATE usernames
     SET status = 'revoked', recyclable = 1, updated_at = ?
     WHERE username_canonical = ? AND status = 'held'`
  ).bind(now, usernameCanonical).run()
  return result.meta?.changes ?? 0
}

export async function getUsernameReleaseHistory(
  db: D1Database,
  usernameCanonical: string
): Promise<UsernameReleaseHistoryRow[]> {
  const result = await db.prepare(
    `SELECT id, username_canonical, released_at, reason
     FROM username_release_history
     WHERE username_canonical = ?
     ORDER BY released_at DESC`
  ).bind(usernameCanonical).all<UsernameReleaseHistoryRow>()
  return result.results
}
```

- [ ] **Step 4: Add the admin routes**

In `src/routes/admin.ts`, import `releaseHeldNameEarly` and
`getUsernameReleaseHistory` from `../db/queries`, then add (mirroring the
validate/try-catch shape of the `admin.get('/username/:name')` handler at 224):

```typescript
admin.get('/username/:name/release-history', async (c) => {
  try {
    const { canonical } = validateUsername(c.req.param('name'))
    const history = await getUsernameReleaseHistory(c.env.DB, canonical)
    return c.json({ ok: true, history })
  } catch (error) {
    if (error instanceof UsernameValidationError) {
      return c.json({ ok: false, error: error.message }, 400)
    }
    console.error('Release-history lookup error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/username/:name/release-hold', async (c) => {
  try {
    const { canonical } = validateUsername(c.req.param('name'))
    const changed = await releaseHeldNameEarly(c.env.DB, canonical)
    if (changed === 0) {
      return c.json({ ok: false, error: 'Name is not currently held' }, 409)
    }
    return c.json({ ok: true, status: 'revoked' })
  } catch (error) {
    if (error instanceof UsernameValidationError) {
      return c.json({ ok: false, error: error.message }, 400)
    }
    console.error('Force-release hold error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})
```

- [ ] **Step 5: Run + typecheck — expect pass**

Run: `npm run typecheck && npx vitest run src/routes/admin-release-history.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries.ts src/routes/admin.ts src/routes/admin-release-history.test.ts
git commit -m "feat(deletion): admin force-release and release-history lookup"
```

---

## Task 6: Full verification + PR prep

- [ ] **Step 1: Full local suite + typecheck**

Run: `npm run test:once && npm run typecheck`
Expected: all green. Note in the PR which suites ran (SQLite suites run here on
Node 22.5+; state that explicitly).

- [ ] **Step 2: Confirm the migration applies cleanly against a fresh DB**

Run: `npx vitest run src/db/migrations.test.ts` (and any migration suite).
Expected: PASS — the full chain including `0012` applies.

- [ ] **Step 3: Rebase onto fresh origin/main; re-run**

```bash
git fetch origin && git rebase origin/main
npm run test:once && npm run typecheck
```

- [ ] **Step 4: Draft PR (do NOT open — Matt-gated)**

Compose the PR body with: summary, motivation (Liz 2026-08-27 policy +
#6126 rescope), linked issue (the new name-server hold issue, filed
Matt-gated), the **Reviewer callouts** block from the spec (pubkey clear;
breadcrumb), and a manual validation plan (staging: prepare → finalize a test
name, confirm `held` + pubkey null + one history row + no resolution; force-release
and re-claim). Conventional-commit title:
`feat(deletion): hold released @divine.video names for one year`.

## Self-Review (plan vs spec)

- Spec "finalize branch (reserved/held), clear pubkey, breadcrumb" → Task 2. ✓
- Spec "two `'burned'` idempotency literals move with status" → Task 2 replay
  keys on `state==='finalized'`; `finishAttempt` EXISTS uses `targetStatus`. ✓
- Spec "expiry → revoked (recyclable=1) via cron" → Task 3. ✓
- Spec "no claim-guard change; held un-claimable" → Task 4 characterization
  test (no production claim change). ✓
- Spec "no reconcile change; optional `held` in getUsernamesUpdatedSince" →
  Task 4. ✓
- Spec "held status in unions + admin filter + fake" + breadcrumb table →
  Task 1. ✓
- Spec "minimal admin surface" → Task 5 (trim line). ✓
- Spec resolution (nip05 unchanged) → no task needed; asserted indirectly by the
  claim/hold tests. ✓
- Type consistency: `releaseHeldNameEarly`/`getUsernameReleaseHistory`/
  `expireHolds`/`RELEASE_HOLD_SECONDS`/`UsernameReleaseHistoryRow` are defined in
  Task 1/3/5 and consumed with matching signatures. ✓
