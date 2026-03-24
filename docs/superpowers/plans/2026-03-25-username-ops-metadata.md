# Username Ops Metadata Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal notes, free-form tags, relevance-ranked search, sorting controls, and lightweight admin stats for username operations.

**Architecture:** Keep `usernames` as the primary record and reuse `admin_notes` for the single internal note. Add a dedicated `username_tags` table plus backend helpers that aggregate tags into search/detail responses, then update the React admin UI to consume the richer API and expose stats, sorting, and metadata editing.

**Tech Stack:** TypeScript, Hono, Cloudflare D1, Vitest, React 18, React Router, Vite, Tailwind CSS

**Baseline note:** `npm run test:once` currently fails on pre-existing `tests/landing.spec.ts` because `@playwright/test` is not installed. Use targeted Vitest commands plus `admin-ui` build verification for this feature.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `migrations/0009_add_username_tags.sql` | Add `username_tags` table and indexes |
| Modify | `src/db/queries.ts` | Add tag-aware query helpers, metadata update helper, stats helper, search ranking, and result shaping |
| Modify | `src/db/queries.test.ts` | Cover tag replacement, detail fetch, stats, and ranked search behavior |
| Modify | `src/routes/admin.ts` | Add detail, metadata, and stats endpoints; validate `sort` |
| Modify | `src/routes/admin.test.ts` | Cover new admin endpoints and search validation |
| Modify | `admin-ui/src/types/index.ts` | Add tags, stats, sort types, and detail response types |
| Modify | `admin-ui/src/api/client.ts` | Add detail fetch, metadata save, stats fetch, and `sort` support |
| Modify | `admin-ui/src/pages/Dashboard.tsx` | Add stats cards, sort control, tag display, and richer search behavior |
| Modify | `admin-ui/src/pages/UsernameDetail.tsx` | Load dedicated detail endpoint and add note/tag editor |

## Chunk 1: Backend data model and admin API

### Task 1: Add failing tests for tags, detail fetch, stats, and ranked search

**Files:**
- Modify: `src/db/queries.test.ts`
- Modify: `src/routes/admin.test.ts`

- [ ] **Step 1: Write failing database query tests**

Add tests that describe:

- replacing a username’s tags normalizes and de-duplicates values
- fetching a username by name returns its tags
- stats include `with_notes`, `with_tags`, `untagged`, `vip`, and `top_tags`
- ranked search prefers exact and prefix username matches over note-only matches

- [ ] **Step 2: Write failing admin route tests**

Add tests that describe:

- `GET /admin/username/:name` returns one record with tags
- `POST /admin/username/metadata` updates `admin_notes` and tags
- `GET /admin/usernames/stats` returns aggregate counts
- invalid `sort` values on search return `400`

- [ ] **Step 3: Run the targeted tests to verify they fail for the right reason**

Run: `npx vitest run src/db/queries.test.ts src/routes/admin.test.ts`

Expected: FAIL with missing helper behavior and/or missing route support for tags, metadata, stats, or `sort`

### Task 2: Add schema and query helpers

**Files:**
- Create: `migrations/0009_add_username_tags.sql`
- Modify: `src/db/queries.ts`

- [ ] **Step 1: Write the migration**

Create `migrations/0009_add_username_tags.sql` with:

```sql
CREATE TABLE IF NOT EXISTS username_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_id INTEGER NOT NULL,
  tag_display TEXT NOT NULL,
  tag_normalized TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(username_id, tag_normalized),
  FOREIGN KEY (username_id) REFERENCES usernames(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_username_tags_username_id
  ON username_tags(username_id);

CREATE INDEX IF NOT EXISTS idx_username_tags_tag_normalized
  ON username_tags(tag_normalized);
```

- [ ] **Step 2: Extend the query types**

In `src/db/queries.ts`, add:

- `tags: string[]` to the shaped search/detail result type used by admin responses
- `sort?: 'relevance' | 'newest' | 'oldest' | 'updated'` to `SearchParams`
- a stats return type for the dashboard aggregates

- [ ] **Step 3: Add tag normalization and replacement helpers**

Implement helpers that:

- normalize free-form tags
- replace all tags for one username atomically
- load tags for one or many usernames

- [ ] **Step 4: Add username detail and stats helpers**

Implement helpers roughly shaped like:

```typescript
getUsernameDetail(db, name)
updateUsernameMetadata(db, { name, adminNotes, tags })
getUsernameStats(db)
```

- [ ] **Step 5: Upgrade search ranking**

Update `searchUsernames` to:

- accept `sort`
- match `admin_notes`
- match tags via `EXISTS` or a joined subquery
- return aggregated tags
- rank by relevance when `sort` is `relevance` or omitted

- [ ] **Step 6: Run the targeted tests to verify the query layer passes**

Run: `npx vitest run src/db/queries.test.ts`

Expected: PASS

### Task 3: Add admin routes for detail, metadata, stats, and sort validation

**Files:**
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Validate the `sort` query parameter**

Allow only:

- `relevance`
- `newest`
- `oldest`
- `updated`

- [ ] **Step 2: Add the detail endpoint**

Implement:

```typescript
admin.get('/username/:name', async (c) => { ... })
```

Use the dedicated query helper and return `404` when no username exists.

- [ ] **Step 3: Add the metadata update endpoint**

Implement:

```typescript
admin.post('/username/metadata', async (c) => { ... })
```

Validate:

- `name` is required
- `tags` is an array when provided
- `admin_notes` is a string or `null`

- [ ] **Step 4: Add the stats endpoint**

Implement:

```typescript
admin.get('/usernames/stats', async (c) => { ... })
```

- [ ] **Step 5: Run route and query tests**

Run: `npx vitest run src/routes/admin.test.ts src/db/queries.test.ts`

Expected: PASS

## Chunk 2: Admin UI data layer and dashboard

### Task 4: Add client and type support for tags, stats, detail, and metadata save

**Files:**
- Modify: `admin-ui/src/types/index.ts`
- Modify: `admin-ui/src/api/client.ts`

- [ ] **Step 1: Extend shared admin UI types**

Add:

- `tags: string[]` on `Username`
- `SearchSort` union type
- `UsernameStats` type
- detail and metadata response types if needed

- [ ] **Step 2: Extend the API client**

Add functions roughly shaped like:

```typescript
searchUsernames(query, status, sort, page, limit)
getUsernameDetail(name)
updateUsernameMetadata(name, adminNotes, tags)
getUsernameStats()
```

- [ ] **Step 3: Run a frontend typecheck/build to catch interface drift**

Run: `npm run build`
Workdir: `admin-ui`

Expected: PASS

### Task 5: Upgrade the dashboard with stats, sorting, and tags

**Files:**
- Modify: `admin-ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add failing UI behavior in code**

Update the component to request stats and use the new search API shape:

- load stats on page load
- include `sort` in searches
- render stats cards
- render tag chips in the results table
- default sort to `relevance`

- [ ] **Step 2: Implement the minimal dashboard UI**

Keep the existing layout patterns and add:

- sort dropdown
- compact stat cards
- tags column or inline tag chips
- note/tag-aware empty state messaging

- [ ] **Step 3: Build the admin UI**

Run: `npm run build`
Workdir: `admin-ui`

Expected: PASS

## Chunk 3: Username detail metadata editing

### Task 6: Switch detail loading to the dedicated endpoint and add note/tag editing

**Files:**
- Modify: `admin-ui/src/pages/UsernameDetail.tsx`

- [ ] **Step 1: Add the new data flow**

Replace the current `searchUsernames(name)` detail lookup with the dedicated detail API.

- [ ] **Step 2: Add metadata editing UI**

Add:

- a textarea bound to `admin_notes`
- a simple free-form tag editor with add/remove chips
- save button and loading/error/success states

- [ ] **Step 3: Preserve existing actions**

Keep assign/revoke flows working after metadata edits and after reload.

- [ ] **Step 4: Build the admin UI again**

Run: `npm run build`
Workdir: `admin-ui`

Expected: PASS

### Task 7: Final targeted verification

**Files:**
- Verify: `src/db/queries.test.ts`
- Verify: `src/routes/admin.test.ts`
- Verify: `admin-ui`

- [ ] **Step 1: Run targeted backend tests**

Run: `npx vitest run src/db/queries.test.ts src/routes/admin.test.ts`

Expected: PASS

- [ ] **Step 2: Run the admin UI build**

Run: `npm run build`
Workdir: `admin-ui`

Expected: PASS

- [ ] **Step 3: Record the known baseline caveat**

Note that full `npm run test:once` still includes the pre-existing `tests/landing.spec.ts` dependency issue unless `@playwright/test` is installed or that suite is split out of the Vitest run.
