# Username Ops Metadata Design

**Date:** 2026-03-25
**Status:** Approved for implementation

## Overview

Extend the admin experience from a basic username registry into an internal operations surface for trust and safety, support, marketing, and outreach. The system should let internal teams keep private notes on each username, apply free-form tags such as `vip`, `brand`, or `impersonation-risk`, search that metadata effectively, and sort results by operational relevance instead of only creation date.

## Goals

- Let internal staff store one internal note per username for shared context.
- Let internal staff add and remove free-form tags per username.
- Improve search so queries match usernames, pubkeys, emails, tags, and notes.
- Improve result ordering so exact and prefix username matches rank above weaker matches.
- Add lightweight admin stats that summarize the state of the namespace and the tagging workflow.
- Preserve the existing reserve, assign, revoke, and burn flows.

## Non-Goals

- No public-facing notes or tags.
- No file attachments, uploads, or per-note documents.
- No full case-management system with timelines, assignees, or audit history.
- No locked taxonomy for tags in v1.

## Data Model

Use the existing `usernames.admin_notes` column as the single internal note field. Do not add a second note column.

Add a new `username_tags` table for free-form tags:

```sql
CREATE TABLE username_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_id INTEGER NOT NULL,
  tag_display TEXT NOT NULL,
  tag_normalized TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(username_id, tag_normalized),
  FOREIGN KEY (username_id) REFERENCES usernames(id) ON DELETE CASCADE
);
```

Add indexes for:

- `username_tags.username_id`
- `username_tags.tag_normalized`
- `usernames.updated_at` if search/result sorting shows it is missing

Normalization rules:

- Trim leading and trailing whitespace
- Collapse internal runs of whitespace to a single space
- Lowercase `tag_normalized`
- Preserve the first-entered display casing in `tag_display`
- Ignore empty tags
- De-duplicate per username by normalized value

## Backend API

Keep the existing admin API surface and add focused endpoints for metadata-driven workflows:

### Existing Search Endpoint

`GET /api/admin/usernames/search`

Extend query parameters:

- `q`: search string, still optional as an empty string
- `status`: existing filter
- `sort`: one of `relevance`, `newest`, `oldest`, `updated`
- `tag`: optional exact tag filter by normalized value
- `has_notes`: optional boolean filter

Search results should include:

- existing username fields
- `tags: string[]`
- `match_reason?: string` for debugging or UI hints if cheap to include

### Username Detail Endpoint

`GET /api/admin/username/:name`

Return one canonical username record plus its tags. This replaces the current client behavior that calls the generic search endpoint and then guesses which row is the exact detail record.

### Username Metadata Update Endpoint

`POST /api/admin/username/metadata`

Request body:

```json
{
  "name": "alice",
  "admin_notes": "Creator outreach in progress.",
  "tags": ["VIP", "creator", "outreach"]
}
```

Behavior:

- validate canonical username exists
- overwrite the note field
- replace the tag set atomically
- bump `updated_at`
- return the updated record and normalized tags

### Username Stats Endpoint

`GET /api/admin/usernames/stats`

Return lightweight aggregates only. No event warehouse or time-series service in v1.

Recommended response shape:

```json
{
  "ok": true,
  "totals": {
    "all": 0,
    "active": 0,
    "reserved": 0,
    "revoked": 0,
    "burned": 0
  },
  "metadata": {
    "with_notes": 0,
    "with_tags": 0,
    "untagged": 0,
    "vip": 0
  },
  "activity": {
    "claimed_7d": 0,
    "claimed_30d": 0,
    "updated_7d": 0,
    "updated_30d": 0
  },
  "top_tags": [
    { "tag": "vip", "count": 0 }
  ]
}
```

## Search and Ranking

The current `LIKE` search ordered by `created_at DESC` is not enough once tags and notes exist. Replace it with weighted ranking.

Recommended precedence:

1. exact canonical username match
2. exact display username match
3. username prefix match
4. username substring match
5. exact tag match
6. tag substring match
7. exact email or pubkey match
8. pubkey or email substring match
9. note substring match

Within the same rank:

- `sort=relevance`: highest relevance, then `updated_at DESC`
- `sort=updated`: `updated_at DESC`
- `sort=newest`: `created_at DESC`
- `sort=oldest`: `created_at ASC`

Implementation guidance:

- keep search SQL in `src/db/queries.ts`
- aggregate tags into each result row
- use `EXISTS` or joined subqueries for tag matches to avoid duplicate username rows
- escape `LIKE` patterns as the current code already does

## Admin UI

### Dashboard

Turn the dashboard into an operations-oriented search screen:

- keep the existing search box and status filter
- add a sort dropdown with `Best match`, `Recently updated`, `Newest`, `Oldest`
- show stats cards above the results table
- display tag chips per row
- keep CSV export available
- make clicking a row open the dedicated detail route

### Username Detail

Upgrade the detail page into the editing surface for internal metadata:

- load by dedicated detail endpoint
- show tags near the page title
- add a notes textarea for internal context
- add a free-form tag editor that supports add/remove chips
- keep assign/revoke actions intact

Notes and tags remain internal-only and should never be included in public endpoints.

## Stats

The first stats slice should serve T&S, support, marketing, and outreach without turning into a separate analytics system.

Recommended metrics:

- total usernames
- active, reserved, revoked, burned counts
- names with notes
- names with tags
- untagged names
- `vip` tag count
- recent claims in 7 and 30 days
- recent updates in 7 and 30 days
- top tags

## Error Handling

- Missing usernames should return `404` on the detail and metadata endpoints.
- Invalid tags should return `400` only for malformed payloads, not for ordinary free-form values.
- Empty tag arrays are valid and mean “remove all tags”.
- Search should continue to allow empty queries for browse mode.
- Stats should degrade to zeros if optional metadata is absent.

## Testing Strategy

- Add migration coverage by verifying query helpers and route handlers against tagged data in unit tests.
- Extend database query tests for tag replacement, detail fetch, stats, and relevance ordering.
- Extend admin route tests for new detail, metadata, stats, and search `sort` validation.
- Build the admin UI after frontend changes.
- Feature verification can stay targeted because the repo already has one unrelated Playwright dependency gap in `tests/landing.spec.ts`.

## Rollout Notes

- Apply the new migration before deploying the updated worker.
- The feature is backward-compatible for existing usernames with no tags or notes.
- Existing `admin_notes` content should appear unchanged after rollout.
