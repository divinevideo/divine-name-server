# Ownership-checked imports and name reconciliation

The name server owns D1 name registration and mirrors its current state to
Fastly. Import callers must use `POST /api/internal/username/import` rather
than write KV directly. The route requires a dedicated `USERNAME_IMPORT_TOKEN`
bearer token and fails closed with 503 until an operator provisions it. It does
not accept the ATProto or deletion service tokens.

Example request (synthetic public key):

```json
{"name":"creator-example","pubkey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","relays":[]}
```

201 means D1 inserted an active `vine-import` row. KV synchronization is attempted
and failures remain queued for cron retry. 409 means a name is taken/reserved, the
pubkey already owns a name, or the pubkey's owner has completed an account
deletion (an import never rebuilds a public identity that deletion removed); it
never updates an existing row or syncs a skipped assignment. The response does
not say which of these applied, so a caller cannot tell a name collision from a
pubkey that is already settled: treat every 409 as a skipped assignment and do
not retry it with a suffix. Replaying a successful import also returns 409 and
leaves ownership unchanged. Current DNS-label validation applies to new imports;
legacy names with dots or underscores need separate operator review, not silent
backfill conversion.

`scripts/import-vine-users.ts` now calls that endpoint for each assignment. It
has no direct Fastly or Wrangler write path. Inject PostgreSQL credentials and,
for `--apply`, `NAME_SERVER_URL` plus `USERNAME_IMPORT_TOKEN` using the credential
manager. Default execution and `--dry-run` read candidates only and report just
the candidate count; `--limit=N` bounds the source query. `--apply` registers
candidates one request at a time, each with a 30-second deadline; conflicts and
invalid rows are counted and skipped. Malformed vanity JSON falls back to the
original username. A service or network error stops the run with a fixed message
(the HTTP status when there was one) and prints the counts so far with
`"stopped": true`. There is no resume point: a re-run starts from the first
candidate, and names already imported return 409, so they are counted as
conflicts. Usage and configuration mistakes, such as the rejected obsolete
`--skip-fastly` flag, print their own fixed message; driver and provider errors
are never printed. No credentials are loaded from sibling `.env` files and
reports contain aggregate counts only.

Before a live `--apply`, verify that the script's derived labels agree with the
names already published in the archived profiles. The script preserves case,
strips combining accents and converts other non-ASCII/non-alphanumeric
characters to collapsed hyphens; this is not proof that another publisher used
the same rule. The derivation is `deriveImportName` in `src/utils/vine-import.ts`;
run it over the archive rows to list the labels to check, since the script's own
report carries counts only. A mismatched label must be reviewed rather than
bulk-registered. For an operator-reviewed backfill, the import API accepts an
explicitly chosen name and validates it without silently rewriting punctuation.
Already-owned pubkeys return 409, so a later attempt with a different label
cannot repair a wrong initial assignment. The code change does not run or
authorize that live backfill or settle names that require a different
publishing rule.

## Operator comparison and repair

These endpoints use the existing admin hostname and authentication boundary:

- `POST /api/admin/sync/fastly/compare` with
  `{"source":"kv","limit":100,"cursor":null}` scans a Fastly key page for
  owner/metadata mismatches, entries without D1 rows, and inactive D1 rows.
  Follow its returned cursor until null, even if a page has no differences.
- Repeat with `source: "d1"` to find active D1 rows with missing KV keys.
  The two scans have separate cursor domains. Neither scan writes data. Errors
  fail the page rather than count a failed read as a match, and the cause is
  logged. A stored value that is not a JSON object is reported as drift
  (`invalid-kv-data` for an active name, `no-d1-row` or `inactive-d1-row` when no
  active row owns the key) instead of failing the page. A key that differs from a
  name only by case, such as `user:Alice` next to `alice`, is not the key the edge
  resolves, so it is reported as `no-d1-row` and left to operator review. Results
  name the affected key and reason, without copying public keys or provider
  errors.
- `POST /api/admin/sync/fastly/repair` with `{"name":"creator-example"}`
  defaults to read-only comparison. Explicit `"dry_run":false` reconciles the
  current D1 state, verifies the result, and retains unsuccessful writes in the
  retry queue. It requires an existing D1 row at entry; inactive rows have their
  stale KV entries deleted. If ownership changes
  during repair, reconciliation follows that newer D1 state.

Comparison is a paginated observation, not an atomic snapshot of either store.
Orphaned KV entries are never automatically imported or deleted by these tools.
An operator must verify provenance before backfilling through the import API.
Do not derive a new owner from a mismatched KV entry.

Migration `0015_add_fastly_sweep_cursor.sql` stores full-table sweep progress.
Once it is applied, each hourly cron invocation also reconciles up to 100 D1 rows
(including nonactive rows), after the existing recent-change and retry-queue
sync. It first compares each key with current D1 state and only reconciles
differences or unsuccessful reads, re-reading current ownership for each write.
An already matching page causes no cache or retry-queue writes. At the end of the table it
wraps to the beginning. KV failures are queued; database failures preserve the
page for retry. At an hourly schedule, 100,000 rows take about 42 days per full
pass. This is eventual self-healing, not a ban on writes made with other
services' Fastly credentials.

The retry queue identifies names needing work, not authoritative payloads. Cron
re-reads D1 for queued names even outside the recent-change window and clears
only the queue generation it observed, preserving concurrent newer enqueues.

## Rollout order

Merging to `main` deploys the Worker automatically, and the deploy workflow does
not apply D1 migrations. The sweep reads its cursor table on every cron run, so
apply the migration before merging:

1. Apply `0015_add_fastly_sweep_cursor.sql` to the remote D1 database:
   `npx wrangler d1 migrations apply divine-name-server-db --remote`.
2. Provision the import token: `npx wrangler secret put USERNAME_IMPORT_TOKEN`.
   Until it is set the import route answers 503.
3. Merge. From the next hourly run the cron also sweeps.
4. Run the live repair and the imported-name backfill as separate operator
   steps. Neither is part of the deploy.

Steps 1, 2 and 4 are operator actions that this change does not perform. If the
Worker is deployed before step 1, each hourly run completes its normal
reconciliation and then fails with `no such table: fastly_sweep_cursor` until the
migration is applied. Nothing else is affected, and the sweep starts from the
first row once the table exists. The sweep has no switch of its own: it runs
whenever the Fastly credentials are configured.
