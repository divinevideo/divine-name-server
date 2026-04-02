# Username Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free-form tagging system to username records for internal admin filtering and categorization.

**Architecture:** Junction table `username_tags` in D1. Three new admin API endpoints (add, remove, list tags). Existing endpoints extended to include tags in responses and support tag filtering. Admin UI updated with tag pills on detail page, autocomplete input, and filter dropdown on dashboard.

**Tech Stack:** Hono (CF Workers), D1 (SQLite), Vitest, React (Vite), TypeScript

---

### Task 1: Database migration

**Files:**
- Create: `migrations/0009_add_username_tags.sql`

- [ ] **Step 1: Write migration**

```sql
-- ABOUTME: Add username_tags junction table for free-form tagging
-- ABOUTME: Tags are lowercase strings attached to username records

CREATE TABLE IF NOT EXISTS username_tags (
  username_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (username_id, tag),
  FOREIGN KEY (username_id) REFERENCES usernames(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_username_tags_tag ON username_tags(tag);
```

- [ ] **Step 2: Apply migration locally**

Run: `npx wrangler d1 execute divine-name-server-db --local --file=migrations/0009_add_username_tags.sql`

- [ ] **Step 3: Commit**

```bash
git add migrations/0009_add_username_tags.sql
git commit -m "feat: add username_tags table migration"
```

---

### Task 2: Tag query functions

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/db/test-helpers.ts`
- Test: `src/db/queries.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/db/queries.test.ts`:

```typescript
import { getTagsForUsername, addTag, removeTag, getAllTags, getTagsForUsernames } from './queries'

describe('username tags', () => {
  it('adds a tag to a username', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual(['vip'])
  })

  it('normalizes tags to lowercase', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, '  VIP  ', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual(['vip'])
  })

  it('prevents duplicate tags', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual(['vip'])
  })

  it('supports multiple tags per username', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vine-legacy', 'matthew@divine.video')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toContain('vip')
    expect(tags).toContain('vine-legacy')
  })

  it('removes a tag', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await removeTag(db, 1, 'vip')
    const tags = await getTagsForUsername(db, 1)
    expect(tags).toEqual([])
  })

  it('returns all distinct tags with counts', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
      { name: 'lelepons', username_canonical: 'lelepons', status: 'reserved', id: 2 },
    ])
    await addTag(db, 1, 'vip', 'matthew@divine.video')
    await addTag(db, 2, 'vip', 'matthew@divine.video')
    await addTag(db, 1, 'vine-legacy', 'matthew@divine.video')
    const allTags = await getAllTags(db)
    expect(allTags).toContainEqual({ tag: 'vip', count: 2 })
    expect(allTags).toContainEqual({ tag: 'vine-legacy', count: 1 })
  })

  it('rejects empty tags', async () => {
    const db = createFakeD1([
      { name: 'kingbach', username_canonical: 'kingbach', status: 'reserved', id: 1 },
    ])
    await expect(addTag(db, 1, '', 'matthew@divine.video')).rejects.toThrow()
    await expect(addTag(db, 1, '   ', 'matthew@divine.video')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/queries.test.ts`
Expected: FAIL (functions not exported)

- [ ] **Step 3: Add tag support to the fake D1 test helper**

In `src/db/test-helpers.ts`, add in-memory tag storage to `createFakeD1`. The fake needs to handle:
- `INSERT OR IGNORE INTO username_tags` -- store `{ username_id, tag, created_at, created_by }`
- `DELETE FROM username_tags WHERE username_id = ? AND tag = ?`
- `SELECT tag FROM username_tags WHERE username_id = ?`
- `SELECT tag, COUNT(*) as count FROM username_tags GROUP BY tag`
- `SELECT DISTINCT tag FROM username_tags` (for autocomplete)
- `SELECT username_id, tag FROM username_tags WHERE username_id IN (...)` (for batch loading)

Add a `tags: { username_id: number; tag: string; created_at: number; created_by: string }[]` array to the closure and extend the SQL dispatcher to match these patterns.

- [ ] **Step 4: Implement query functions**

Add to `src/db/queries.ts`:

```typescript
export async function addTag(
  db: D1Database,
  usernameId: number,
  tag: string,
  createdBy?: string
): Promise<void> {
  const normalized = tag.trim().toLowerCase()
  if (!normalized) throw new Error('Tag cannot be empty')
  await db.prepare(
    'INSERT OR IGNORE INTO username_tags (username_id, tag, created_at, created_by) VALUES (?, ?, ?, ?)'
  ).bind(usernameId, normalized, Math.floor(Date.now() / 1000), createdBy || null).run()
}

export async function removeTag(
  db: D1Database,
  usernameId: number,
  tag: string
): Promise<void> {
  const normalized = tag.trim().toLowerCase()
  await db.prepare(
    'DELETE FROM username_tags WHERE username_id = ? AND tag = ?'
  ).bind(usernameId, normalized).run()
}

export async function getTagsForUsername(
  db: D1Database,
  usernameId: number
): Promise<string[]> {
  const result = await db.prepare(
    'SELECT tag FROM username_tags WHERE username_id = ? ORDER BY tag'
  ).bind(usernameId).all<{ tag: string }>()
  return result.results.map(r => r.tag)
}

export async function getTagsForUsernames(
  db: D1Database,
  usernameIds: number[]
): Promise<Map<number, string[]>> {
  if (usernameIds.length === 0) return new Map()
  const placeholders = usernameIds.map(() => '?').join(',')
  const result = await db.prepare(
    `SELECT username_id, tag FROM username_tags WHERE username_id IN (${placeholders}) ORDER BY tag`
  ).bind(...usernameIds).all<{ username_id: number; tag: string }>()
  const map = new Map<number, string[]>()
  for (const row of result.results) {
    if (!map.has(row.username_id)) map.set(row.username_id, [])
    map.get(row.username_id)!.push(row.tag)
  }
  return map
}

export async function getAllTags(
  db: D1Database
): Promise<{ tag: string; count: number }[]> {
  const result = await db.prepare(
    'SELECT tag, COUNT(*) as count FROM username_tags GROUP BY tag ORDER BY tag'
  ).bind().all<{ tag: string; count: number }>()
  return result.results
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db/queries.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/queries.ts src/db/queries.test.ts src/db/test-helpers.ts
git commit -m "feat: add tag query functions with tests"
```

---

### Task 3: Admin API endpoints for tags

**Files:**
- Modify: `src/routes/admin.ts`
- Test: `src/routes/admin.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/routes/admin.test.ts`:

```typescript
describe('tags', () => {
  it('POST /admin/username/:name/tags adds a tag', async () => {
    const db = createMockDB() // seed with a reserved name
    const req = new Request('http://names.admin.divine.video/admin/username/kingbach/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
      body: JSON.stringify({ tag: 'vip' }),
    })
    const res = await app.fetch(req, { DB: db }, { waitUntil: () => {} })
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.tags).toContain('vip')
  })

  it('DELETE /admin/username/:name/tags/:tag removes a tag', async () => {
    const db = createMockDB()
    // First add a tag
    await app.fetch(new Request('http://names.admin.divine.video/admin/username/kingbach/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
      body: JSON.stringify({ tag: 'vip' }),
    }), { DB: db }, { waitUntil: () => {} })
    // Then remove it
    const res = await app.fetch(new Request('http://names.admin.divine.video/admin/username/kingbach/tags/vip', {
      method: 'DELETE',
      headers: { 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
    }), { DB: db }, { waitUntil: () => {} })
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.ok).toBe(true)
    expect(json.tags).not.toContain('vip')
  })

  it('GET /admin/tags returns all tags with counts', async () => {
    const db = createMockDB()
    // Add tags to two names
    await app.fetch(new Request('http://names.admin.divine.video/admin/username/kingbach/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
      body: JSON.stringify({ tag: 'vip' }),
    }), { DB: db }, { waitUntil: () => {} })
    const res = await app.fetch(new Request('http://names.admin.divine.video/admin/tags', {
      method: 'GET',
      headers: { 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
    }), { DB: db }, { waitUntil: () => {} })
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.tags).toContainEqual({ tag: 'vip', count: 1 })
  })

  it('returns 404 for tags on nonexistent username', async () => {
    const db = createMockDB()
    const res = await app.fetch(new Request('http://names.admin.divine.video/admin/username/doesnotexist/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
      body: JSON.stringify({ tag: 'vip' }),
    }), { DB: db }, { waitUntil: () => {} })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: FAIL (routes not defined)

- [ ] **Step 3: Implement tag routes**

Add to `src/routes/admin.ts`:

```typescript
import { addTag, removeTag, getTagsForUsername, getAllTags, getUsernameByName } from '../db/queries'

// Add tag to username
admin.post('/username/:name/tags', async (c) => {
  const name = c.req.param('name')
  const { tag } = await c.req.json<{ tag: string }>()
  const createdBy = c.req.header('Cf-Access-Authenticated-User-Email') || 'unknown'

  const username = await getUsernameByName(c.env.DB, name)
  if (!username) return c.json({ ok: false, error: 'Username not found' }, 404)

  try {
    await addTag(c.env.DB, username.id, tag, createdBy)
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 400)
  }

  const tags = await getTagsForUsername(c.env.DB, username.id)
  return c.json({ ok: true, tags })
})

// Remove tag from username
admin.delete('/username/:name/tags/:tag', async (c) => {
  const name = c.req.param('name')
  const tag = c.req.param('tag')

  const username = await getUsernameByName(c.env.DB, name)
  if (!username) return c.json({ ok: false, error: 'Username not found' }, 404)

  await removeTag(c.env.DB, username.id, tag)
  const tags = await getTagsForUsername(c.env.DB, username.id)
  return c.json({ ok: true, tags })
})

// List all tags with counts
admin.get('/tags', async (c) => {
  const tags = await getAllTags(c.env.DB)
  return c.json({ tags })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts src/routes/admin.test.ts
git commit -m "feat: add tag admin API endpoints"
```

---

### Task 4: Include tags in existing endpoints

**Files:**
- Modify: `src/routes/admin.ts` (username detail, search, CSV export)
- Modify: `src/db/queries.ts` (searchUsernames tag filter)
- Test: `src/routes/admin.test.ts`

- [ ] **Step 1: Write failing test for tags in username detail**

```typescript
it('GET /admin/username/:name includes tags', async () => {
  const db = createMockDB()
  // Add a tag first
  await app.fetch(new Request('http://names.admin.divine.video/admin/username/kingbach/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
    body: JSON.stringify({ tag: 'vip' }),
  }), { DB: db }, { waitUntil: () => {} })

  const res = await app.fetch(new Request('http://names.admin.divine.video/admin/username/kingbach', {
    method: 'GET',
    headers: { 'Cf-Access-Authenticated-User-Email': 'matthew@divine.video' },
  }), { DB: db }, { waitUntil: () => {} })
  const json = await res.json() as any
  expect(json.tags).toContain('vip')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/admin.test.ts`

- [ ] **Step 3: Add tags to username detail response**

In the existing `GET /username/:name` handler in `admin.ts`, after fetching the username, add:

```typescript
const tags = await getTagsForUsername(c.env.DB, username.id)
return c.json({ ...username, tags })
```

- [ ] **Step 4: Add tag filter to searchUsernames**

In `src/db/queries.ts`, add `tag?: string` to `SearchParams`. When present, add a JOIN:

```typescript
if (params.tag) {
  // Prepend JOIN to query
  const tagFilter = `EXISTS (SELECT 1 FROM username_tags ut WHERE ut.username_id = usernames.id AND ut.tag = ?)`
  if (whereClause) {
    whereClause += ` AND ${tagFilter}`
  } else {
    whereClause = tagFilter
  }
  queryParams.push(params.tag.trim().toLowerCase())
}
```

- [ ] **Step 5: Wire tag query param in search route**

In the search handler in `admin.ts`, pass `tag: c.req.query('tag')` to `searchUsernames`.

After getting search results, batch-load tags for the result set:

```typescript
const ids = results.results.map(r => r.id)
const tagMap = await getTagsForUsernames(c.env.DB, ids)
const resultsWithTags = results.results.map(r => ({
  ...r,
  tags: tagMap.get(r.id) || []
}))
```

- [ ] **Step 6: Add tags to CSV export**

In the export handler, after fetching results, batch-load tags and add a `tags` column (comma-joined).

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin.ts src/db/queries.ts src/routes/admin.test.ts
git commit -m "feat: include tags in username detail, search filter, and CSV export"
```

---

### Task 5: Admin UI - API client

**Files:**
- Modify: `admin-ui/src/api/client.ts`
- Modify: `admin-ui/src/types/` (add tag types if needed)

- [ ] **Step 1: Add tag API functions**

In `admin-ui/src/api/client.ts`:

```typescript
export async function addTagToUsername(name: string, tag: string): Promise<{ ok: boolean; tags: string[] }> {
  const res = await fetch(`/api/admin/username/${encodeURIComponent(name)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  })
  return res.json()
}

export async function removeTagFromUsername(name: string, tag: string): Promise<{ ok: boolean; tags: string[] }> {
  const res = await fetch(`/api/admin/username/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
  })
  return res.json()
}

export async function getAllTags(): Promise<{ tags: { tag: string; count: number }[] }> {
  const res = await fetch('/api/admin/tags')
  return res.json()
}
```

- [ ] **Step 2: Commit**

```bash
git add admin-ui/src/api/client.ts
git commit -m "feat: add tag API client functions"
```

---

### Task 6: Admin UI - tag display and management on detail page

**Files:**
- Modify: `admin-ui/src/pages/UsernameDetail.tsx`

- [ ] **Step 1: Add tag pills with remove and autocomplete input**

In `UsernameDetail.tsx`, add a tags section below the existing metadata. The component should:

- Display current tags as pills with an X button to remove (calls `removeTagFromUsername`).
- Show an input field. On focus or typing, fetch `getAllTags()` and filter to matching suggestions.
- On enter or selecting a suggestion, call `addTagToUsername` and update local state.
- Refresh the username detail after tag changes to stay in sync.

Keep the implementation simple -- no external component library. Use existing CSS patterns from the page.

- [ ] **Step 2: Build and test locally**

Run: `cd admin-ui && npm run build`
Then: `cd .. && npx wrangler dev` and test at `http://localhost:8787`

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/pages/UsernameDetail.tsx
git commit -m "feat: add tag management to username detail page"
```

---

### Task 7: Admin UI - tag filter on dashboard

**Files:**
- Modify: `admin-ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add tag filter dropdown**

In `Dashboard.tsx`:

- On mount, fetch `getAllTags()` to populate a dropdown.
- Add the dropdown alongside the existing status filter.
- When a tag is selected, pass `tag` query parameter to the search API.
- Display tags as small labels on each row in the results table.

- [ ] **Step 2: Build and test locally**

Run: `cd admin-ui && npm run build`
Then: `cd .. && npx wrangler dev` and verify filtering works.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/pages/Dashboard.tsx
git commit -m "feat: add tag filter and display to dashboard"
```

---

### Task 8: Deploy migration and verify

- [ ] **Step 1: Apply migration to production D1**

Run: `npx wrangler d1 execute divine-name-server-db --remote --file=migrations/0009_add_username_tags.sql`

- [ ] **Step 2: Deploy worker**

Run: `npx wrangler deploy`

- [ ] **Step 3: Verify via API**

```bash
# Add a tag
curl -X POST https://names.admin.divine.video/api/admin/username/kingbach/tags \
  -H "Content-Type: application/json" \
  -d '{"tag": "vip"}'

# Check it
curl https://names.admin.divine.video/api/admin/username/kingbach

# List all tags
curl https://names.admin.divine.video/api/admin/tags
```

- [ ] **Step 4: Commit any final fixes**

```bash
git commit -m "chore: production deploy verification"
```
