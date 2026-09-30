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
and failures remain queued for cron retry. 409 means a name is taken/reserved or
the pubkey already owns a name; it never updates an existing row or syncs a
skipped assignment. A caller may choose a suffix for a name collision, but must
not keep trying suffixes when the pubkey already owns a name. Replaying a
successful import returns 409 and leaves ownership unchanged. Current DNS-label
validation applies to new imports; legacy names with dots or underscores need
separate operator review, not silent backfill conversion.

`scripts/import-vine-users.ts` now calls that endpoint for each assignment. It
has no direct Fastly or Wrangler write path. Inject PostgreSQL credentials and,
for `--apply`, `NAME_SERVER_URL` plus `USERNAME_IMPORT_TOKEN` using the credential
manager. Default execution and `--dry-run` read candidates only; `--limit=N`
bounds the source query. `--apply` registers candidates; conflicts and invalid
rows are counted and skipped. Malformed vanity JSON falls back to the original
username. Authentication/service errors stop the run with a safe HTTP status
when available. The obsolete `--skip-fastly` flag is rejected. No credentials are
loaded from sibling `.env` files and reports contain aggregate counts only.

## Operator comparison and repair

These endpoints use the existing admin hostname and authentication boundary:

- `POST /api/admin/sync/fastly/compare` with
  `{"source":"kv","limit":100,"cursor":null}` scans a Fastly key page for
  owner/metadata mismatches, entries without D1 rows, and inactive D1 rows.
  Follow its returned cursor until null, even if a page has no differences.
- Repeat with `source: "d1"` to find active D1 rows with missing KV keys.
  The two scans have separate cursor domains. Neither scan writes data. Errors
  fail the page rather than count a failed read as a match. Results name the
  affected key and reason, without copying public keys or provider errors.
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
After migration and deployment, each existing cron invocation reconciles up to
100 D1 rows (including nonactive rows), re-reading current ownership for each
write. At the end it wraps to the beginning. KV failures are queued; database
failures preserve the page for retry. At an hourly schedule, 100,000 rows take
about 42 days per full pass, in addition to the existing six-hour delta and retry
queue. This is eventual self-healing, not a ban on writes made with other
services' Fastly credentials.

This change has no visual UI changes. **Live repair/backfill, credential
provisioning, applying the migration and deployment are operator steps awaiting
Daniel's authorization; this code change does not execute them.**
