# Fastly KV Cron Sync Scaling

**Date:** 2026-05-06
**PR:** #44 (`fix/cron-sync-scaling`)
**Related:** #40 (Fastly KV sync broken), #43 (FASTLY_STORE_ID fix)

## Problem

The hourly cron reconciliation syncs D1 usernames to Fastly KV for edge NIP-05
resolution. It fetches all ~131K active users and syncs them one-by-one. This
times out on every run.

Inline syncs (on claim/assign/revoke) work individually, but there is no
working reconciliation path to catch missed writes or recover from outages.

### Growth data (May 2026)

| Metric | Value |
|--------|-------|
| Total active usernames | 131,682 |
| Claims in May (6 days) | 41,086 (~7K/day) |
| Typical hourly updates | 10-34 |
| Peak daily spike (May 2) | 34,876 (bulk import) |

The delta sync (2-hour window) handles steady state easily. Spike days and
full backfills require concurrency and pagination.

## Design

### 1. Concurrent sync utility

**File:** `src/utils/fastly-sync.ts`

Add `syncBatch`: processes an array of username records with bounded
concurrency (default 10 in-flight Fastly API calls).

```typescript
interface SyncItem {
  username: string
  action: 'sync' | 'delete'
  data?: UsernameKVData
}

interface SyncBatchResult {
  synced: number
  deleted: number
  failed: number
  errors: string[]
}

async function syncBatch(
  env: FastlyEnv,
  items: SyncItem[],
  options?: { concurrency?: number }
): Promise<SyncBatchResult>
```

Implementation: simple promise pool. Maintains a set of in-flight promises,
starts a new one each time one resolves, capped at `concurrency`. No new
dependencies.

Existing `syncUsernameToFastly` and `deleteUsernameFromFastly` are unchanged.
`syncBatch` composes them.

**Tests:**
- Verify concurrency limit is respected (mock fetch with delay, assert no more
  than N concurrent calls)
- Verify mixed active/revoked items route to PUT vs DELETE correctly
- Verify partial failures don't abort the batch (all items processed)
- Verify error array contains failed usernames with error messages

### 2. Delta cron handler

**File:** `src/index.ts`

Replace the sequential loop in the scheduled handler with `syncBatch`:

```typescript
async scheduled(event, env, ctx) {
  const expired = await expireStaleReservations(env.DB)
  if (expired > 0) console.log(`Cron: expired ${expired} stale reservations`)

  const twoHoursAgo = Math.floor(Date.now() / 1000) - (2 * 60 * 60)
  const changed = await getUsernamesUpdatedSince(env.DB, twoHoursAgo)

  // Filter out active users without pubkeys (reserved names, not syncable)
  const syncable = changed.filter(u =>
    (u.status === 'active' && u.pubkey) || u.status === 'revoked' || u.status === 'burned'
  )

  const items = syncable.map(u => ({
    username: u.username_canonical || u.name,
    action: (u.status === 'active') ? 'sync' as const : 'delete' as const,
    data: (u.status === 'active') ? {
      pubkey: u.pubkey!,
      relays: parseRelayHints(u.relays),
      status: 'active',
      atproto_did: u.atproto_did,
      atproto_state: u.atproto_state,
    } : undefined,
  }))

  const results = await syncBatch(env, items, { concurrency: 10 })
  console.log(`Cron delta sync: ${changed.length} changed, ${results.synced} synced, ${results.deleted} deleted, ${results.failed} failed`)
}
```

**Migration:** `0010_add_updated_at_index.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_usernames_updated_at ON usernames (updated_at);
```

Without this index, `getUsernamesUpdatedSince` scans all 131K+ rows.

**Tests:**
- Scheduled handler calls `syncBatch` with correctly mapped items
- 2-hour window calculation is correct
- `expireStaleReservations` runs before sync
- Handler completes without error when no changes exist (empty array)

### 3. Paginated full-sync API

**File:** `src/routes/admin.ts`

Refactor `POST /api/admin/sync/fastly` to accept pagination:

**Request body:**
```json
{
  "limit": 500,
  "cursor": "12847",
  "dry_run": false
}
```

All fields optional. Defaults: `limit=500`, `cursor=null` (start from
beginning), `dry_run=false`.

**Response:**
```json
{
  "ok": true,
  "synced": 487,
  "deleted": 3,
  "failed": 2,
  "cursor": "13347",
  "remaining": 130692,
  "errors": ["someuser: Fastly API error: 429"]
}
```

`cursor` is null when the sync is complete (no more pages).

**New query:** `src/db/queries.ts`

```typescript
async function getActiveUsernamesPaginated(
  db: D1Database,
  afterId: number | null,
  limit: number
): Promise<Username[]>
```

Query: `SELECT * FROM usernames WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?`

When `afterId` is null, omit the `id > ?` clause (first page).

Each page uses `syncBatch` with concurrency 10. In dry-run mode, the query
runs but `syncBatch` is skipped; the response reports what would be synced
(count of users with pubkeys vs without).

**Tests:**
- First page (no cursor): returns users from id=1, includes cursor for next page
- Middle page: returns users after cursor, correct remaining count
- Last page: returns remaining users, cursor is null
- Dry-run: returns counts, zero Fastly API calls made
- Auth middleware protects the endpoint (unauthenticated request rejected)
- Error handling: Fastly config missing returns 400

### 4. CLI backfill script

**File:** `scripts/backfill-fastly-kv.sh`

Shell script that loops through the paginated admin API.

**Usage:**
```bash
# Dry run -- report what would sync
./scripts/backfill-fastly-kv.sh --dry-run

# Apply -- sync for real
./scripts/backfill-fastly-kv.sh --apply

# Custom page size
./scripts/backfill-fastly-kv.sh --apply --limit=1000
```

**Requirements:**
- `ADMIN_TOKEN` env var (CF Access service token or Keycast session JWT)
- `API_BASE` env var (defaults to `https://names.admin.divine.video`)

**Behavior:**
- Pages through `POST /api/admin/sync/fastly` until cursor is null
- Prints progress per page: `Page 12/~263: 5987 synced, 0 failed, 125695 remaining`
- Stops on any page returning `ok: false` (prints error, exits non-zero)
- On completion, prints totals

**Testing:** Manual. Run `--dry-run` against staging, verify counts match D1
active user count. Then `--apply` against staging, spot-check Fastly KV
entries.

### 5. Admin UI button

**File:** `admin-ui/src/` (component TBD based on existing UI structure)

Add "Sync to Fastly KV" button on the admin dashboard:

1. Click triggers a confirmation dialog: "This will sync all active usernames
   to Fastly KV. This may take several minutes. Continue?"
2. On confirm, UI loops calling the paginated endpoint
3. Progress bar shows: `Syncing... 5,987 / 131,682 (4%)`
4. On completion: "Sync complete. 131,400 synced, 12 failed."
5. On error: show error message, stop syncing
6. Cancel button stops the loop after the current page completes

**Testing:** Manual verification on staging. Click button, watch progress
complete, spot-check Fastly KV.

## Migration plan

1. Merge PR #43 first (FASTLY_STORE_ID as var) -- inline syncs start working
2. Deploy PR #44 (this work) -- delta cron + paginated API + script
3. Run migration `0010_add_updated_at_index.sql` on production D1
4. Run `scripts/backfill-fastly-kv.sh --dry-run` to verify counts
5. Run `scripts/backfill-fastly-kv.sh --apply` to backfill Fastly KV
6. Verify: spot-check NIP-05 resolution on several `*.divine.video` subdomains
7. Monitor next cron tick in worker logs -- should show small delta count

## Out of scope

- Fastly KV bulk API (doesn't exist -- single PUT/DELETE per key)
- CF Queues or Durable Objects (unnecessary complexity for this use case)
- Bidirectional sync (Fastly KV is write-only from name-server's perspective)
- Changing the cron frequency (hourly is fine with delta sync)
