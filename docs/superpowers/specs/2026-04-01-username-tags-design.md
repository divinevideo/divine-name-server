# Username Tags

Internal tagging system for the name-server admin UI. Tags are free-form labels attached to username records for filtering, categorization, and operational visibility. VIP designation is the driving use case, but the system is generic.

## Schema

New junction table `username_tags`:

```sql
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

- `tag` is normalized to lowercase and trimmed on write.
- `created_by` is the CF Access email of the admin who added the tag.
- No separate tags vocabulary table. Existing tags are discovered via `SELECT DISTINCT tag FROM username_tags ORDER BY tag`.
- Multiple tags per name. Duplicate prevented by composite primary key.

## API

Three new admin endpoints following existing patterns in the admin router:

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/admin/username/:name/tags` | `{ "tag": "vip" }` | `{ tags: ["vip", ...] }` |
| DELETE | `/api/admin/username/:name/tags/:tag` | -- | `{ tags: [...] }` |
| GET | `/api/admin/tags` | -- | `[{ "tag": "vip", "count": 42 }, ...]` |

Modifications to existing endpoints:

- `GET /api/admin/username/:name` -- response includes `tags: string[]` (joined from `username_tags`).
- `GET /api/admin/usernames/search` -- accepts optional `tag` query parameter. When present, filters results to names with that tag via JOIN.
- `GET /api/admin/export/csv` -- includes a `tags` column (comma-joined).

Tag normalization: lowercase, trimmed, reject empty strings. No character restrictions beyond that.

## Admin UI

**Username detail page:**
- Tags section showing current tags as removable pills/chips.
- Input field with autocomplete populated from `GET /api/admin/tags`.
- Typing filters existing tags. Pressing enter or selecting creates a new tag if it doesn't exist.

**Search/dashboard page:**
- Tag filter dropdown alongside existing status filter, populated from `GET /api/admin/tags`.
- Tags displayed as small labels on each row in the results table.

**CSV export:**
- Tags column added (comma-joined values).

## Scope boundaries

- Tags live on the username record (not the pubkey).
- Internal admin use only. No public API exposure.
- No per-tag visual treatment, warnings, or special behavior. Filter and display only.
- External service consumption (resurrection, relay-manager querying tags) is not in scope but the API shape doesn't preclude it -- `GET /api/admin/tags` and the search filter would work for service-to-service use.

## Testing

- Tag CRUD (add, remove, duplicate prevention, case normalization).
- Search filtering by tag returns correct results.
- Tags included in username detail response.
- Tags included in CSV export.
- Autocomplete endpoint returns distinct tags with counts.
- Cascade delete: revoking/burning a name removes its tags.
