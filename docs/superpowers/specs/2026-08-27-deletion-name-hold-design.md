# divine-name-server — Deletion name release: 1-year hold (design)

**Goal:** When account deletion releases a `@divine.video` name, the name is
**held for one year** (stops resolving immediately, cannot be re-registered
during the year), then returns to circulation. Reserved names return to the
reserve instead. This replaces today's permanent burn on the deletion path.

> This spec is grounded in the actual `origin/main` code (PRs #79 "preserve
> names when account deletion cannot finish" and #80 "expose deletion release
> coordination"). Where the earlier draft assumed a shape that differed from the
> code, the grounded correction is called out inline as **[grounded]**.

## Source of truth and alignment

Liz Sweigart's 2026-08-27 deletion-policy post (Slack #C0B1P7Z6G57), verbatim
under "What we agreed":

- *"Deleted Divine NIP-05 names should be held for one year rather than
  immediately reissued. Reserved names return to the reserve."* → the whole of
  this design, including the reserved-return branch.
- *"A completed deletion needs to cover … the Divine-controlled NIP-05 name
  service."* → release is mandatory (mobile Track A, shipped as
  divine-mobile#8225).

divine-mobile#6126's rescoping comment already names "a time-boxed hold that
expires, the reserved-name return path, and a support-visible
released-by-deletion marker" as the expected name-server follow-up. No
document (Slack, issues, PR comments) specifies handling that contradicts this
design.

## Reviewer callouts (surface these on the PR and to Liz/Daniel)

Two elements go **slightly beyond the literal policy text** and need a
reviewer's conscious sign-off:

1. **`pubkey` is cleared from the `usernames` row on finalize.** The policy says
   the name is held; it does not say what happens to the deleted owner's pubkey.
   Today's burn leaves the pubkey on the row. We clear it (`pubkey = NULL`) at
   finalize so a held/expired name no longer carries a deleted account's
   identity. This aligns with "a completed deletion removes the identity" and
   with the breadcrumb table deliberately storing no pubkey. The coordinator's
   `username_release_attempts` ledger retains the pubkey as its internal audit
   trail (not scrubbed).
2. **A permanent breadcrumb (`username_release_history`).** A minimal,
   append-only record (`username_canonical`, `released_at`, `reason`) with **no
   pubkey**, so support can answer "this handle previously belonged to a
   since-deleted account" after the name is reissued. It is barebones and taken
   as an opportunity for impersonation triangulation on names that are held and
   later reassigned — slightly beyond the documented policy, not divergent from
   it. Revertible; reviewed as part of this PR.

## Locked decisions

- **Reserved-return keyed on `isReservedWord(canonical)`.** A name only reaches
  finalize if the deleting user owned it `active`; self-service claim blocks
  reserved words, so an active reserved-word name can only exist via admin grant.
  On finalize such a name returns to `reserved` (no hold, no breadcrumb). The
  authoritative signal is the `reserved_words` table (`isReservedWord`), **not**
  `reserved_reason` (which is free-text provenance such as `%Vine%`). Confirmed
  against Liz's "Reserved names return to the reserve."
- **Expiry lands in `status='revoked'` (recyclable=1). [grounded]** The claim
  path is an allow-list: `claimUsername` only accepts an existing row when
  `status='revoked'`. So "returns to circulation" must be expressed as
  `revoked`, not a deleted row and not a new `available` status (either would
  need new claim-path code). The breadcrumb row survives the reclaim's
  `ON CONFLICT DO UPDATE` overwrite.
- **Clear `pubkey` on finalize** (see reviewer callout 1).

## Scope

**In:** the finalize path (`finalizeReleaseAttempt`), a `held` status, the
expiry sweep in the existing cron, the reserved-return branch, a minimal admin
surface, and the breadcrumb table.

**Out:** legal hold (separate T&S project, per Liz); the ban-export snapshot
(separate moderation workstream, 30-day, per Liz); divine-mobile#6127
reversible deletion; the mobile flow (Track A, shipped); the legacy
immediate-burn `POST /api/username/release` endpoint (already `TODO(#78)` for
removal — left as-is).

## Data model

- Add **`held`** to the `status` union in `src/db/queries.ts` (the `Username`
  interface at line 23 and the `SearchParams`/admin filter unions) and to
  `VALID_ADMIN_STATUSES` in `src/routes/admin.ts`. The column is free-form
  `TEXT` with no CHECK, so the value itself needs no column migration.
- **No new duration column.** The hold starts at the `revoked_at` timestamp
  finalize already sets; the one-year window is a **hardcoded constant** in the
  sweep (hard one year; admin override only, no soft/automatic config).
- New append-only table **`username_release_history`**: `username_canonical
  TEXT`, `released_at INTEGER`, `reason TEXT` (e.g. `'deletion'`). **No pubkey.**
  Survives reissue (the `usernames` row is overwritten on reclaim, so the
  deletion fact only persists here). Added by a new migration.

## Release path — the finalize change

`finalizeReleaseAttempt` (queries.ts:271) today sets `status='burned',
recyclable=0 … WHERE status='pending-release'`. It becomes a branch:

- If `isReservedWord(canonical)` → `status='reserved'`, `pubkey=NULL` (return to
  the reserve; no hold, no breadcrumb).
- Else → `status='held'`, `recyclable=0`, `revoked_at=now`, `pubkey=NULL`, **and**
  append one `username_release_history` row (`canonical`, `released_at=now`,
  `reason='deletion'`).

**[grounded] Idempotency literals must move with the target status.** finalize
has two embedded `'burned'` literals that gate idempotent replay: the replay
short-circuit (line 280, `currentUsername?.status === 'burned'`) and the
`finishAttempt` EXISTS predicate (line 299, `status = 'burned'`). Both must
become aware of the new terminal status (`held` or `reserved`) or a
re-delivered finalize call will fail its idempotency check. This is the main
implementation subtlety.

**Coordinator contract unchanged.** funnelcake still calls
`POST /api/internal/username/release/finalize`; the name-server alone decides
the terminal state. **No funnelcake change.**

## Resolution (no change)

`nip05.ts` already returns not-found for any `status !== 'active'`, so a `held`
(and `reserved`) name stops resolving immediately. **[grounded] No change.**

## Fastly KV (minimal change)

**[grounded]** `desiredItem` in `username-fastly-reconcile.ts` treats any
non-active status as `delete`-from-KV, so the finalize route's existing
`reconcileUsernameFastly` call removes a `held` name from Fastly with no change.
The only optional touch: add `'held'` to the cron's `getUsernamesUpdatedSince`
status filter (queries.ts:432) so the 6-hour backstop re-affirms the KV delete;
the durable `fastly_sync_queue` already covers the retry, so this is
belt-and-suspenders.

## Expiry — reuse the hourly cron

The existing `scheduled()` handler (`src/index.ts:109`, `crons=["0 * * * *"]`,
already expiring stale reservations and rolling back stale release attempts)
gains one step: names with `status='held' AND revoked_at <= now - ONE_YEAR`
transition to `status='revoked', recyclable=1` (claimable again). The
`username_release_history` row is retained. No Fastly action needed at the
transition (both `held` and `revoked` map to KV-delete), though `updated_at`
changes so the backstop re-affirms harmlessly. Hourly granularity against a
one-year hold is fine.

## Claim (no change)

**[grounded]** The claim path is an allow-list — `claimUsername` (queries.ts:384)
only accepts an existing row at `status='revoked'` (or the caller's own active
row). `held` is therefore un-claimable by default, exactly like `burned`. **No
claim-guard change needed.** After expiry (`held → revoked`) a fresh claim
succeeds; the claim/support path can read `username_release_history` for the
breadcrumb. `burned` stays as the admin permanent-kill for abusive handles;
deletion-release uses `held`.

## Admin surface

Minimal handlers on the existing `admin` Hono app, inheriting its `admin.use('*')`
auth (Cloudflare Access / Keycast session):

- **Force-release a held name early:** `held → revoked` (recyclable=1),
  retaining the breadcrumb.
- **Look up a name's release history:** read `username_release_history` for a
  canonical.

No automatic/soft configuration — admin action only.

## Testing (unit + migration)

- finalize of a non-reserved name → `held`, `pubkey` cleared, one
  `username_release_history` row (no pubkey stored).
- finalize of a reserved-origin name (in `reserved_words`) → `reserved`, `pubkey`
  cleared, no hold, no history row.
- finalize idempotency: a replayed finalize after `held`/`reserved` returns
  `replayed`, not `conflict` (proves the moved idempotency literals).
- cron sweep clears only holds older than one year: a hold at 364 days is
  untouched, at 366 days transitions to `revoked` (recyclable=1); history row
  retained.
- `POST /claim` rejects a `held` name; after the sweep clears it, the claim
  succeeds.
- admin force-release moves a `held` name to `revoked` and retains history.
- `burned` remains permanent (admin path unaffected).
- migration test for the new table.

## Open items (resolve during writing-plans)

1. **Admin-auth mechanism for the new handlers** — mirror the existing
   `admin.use('*')` middleware; confirm no extra scoping is expected.
