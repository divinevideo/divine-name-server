# Fastly Automation Token Rotation

This runbook replaces the temporary personal `FASTLY_API_TOKEN` Cloudflare Worker secret with a Fastly automation token for the `divine-names` KV sync path.

## Why This Matters

`divine-name-server` writes username records from D1 into Fastly KV so Divine edge routing can resolve names without querying D1. A personal Fastly token can expire or disappear with a user account, which silently breaks the async sync path.

## Token Requirements

Only a Fastly superuser can create the replacement token, and Fastly requires the superuser to be in sudo mode. If the token creation form does not show a `Type` selector with an `Automation token` option, stop and ask a Fastly superuser to create the token.

Create the token in the Fastly control panel:

1. Go to `Account` > `API tokens` > `Personal tokens`.
2. Click `Create token`.
3. Re-authenticate when Fastly prompts for sudo mode.
4. Confirm the form shows `Type`; select `Automation token`.

Use these settings:

- Name: `divine-name-server-fastly-kv-sync`
- Token type: automation token
- Scope: global scope
- Access: all services
- Expiration: no expiration, or the longest approved lifetime if policy requires one

Do not create a user token as a substitute unless this is an explicit emergency fallback. Fastly KV Store writes use account-level APIs, so a service-limited token is not sufficient.

## Rotate The Worker Secret

Run this from the repository root with a Cloudflare account that can edit the production Worker secret:

```bash
npx wrangler secret put FASTLY_API_TOKEN
```

Paste the new Fastly automation token when prompted. Do not commit the token, paste it into issue comments, or store it in plaintext docs.

`FASTLY_API_TOKEN` is the only secret being rotated. `FASTLY_STORE_ID` is checked in as a `[vars]` resource identifier in `wrangler.toml`; do not change it during token rotation unless the `divine-names` Fastly KV store itself changes.

Before verification, check whether production has a stale `FASTLY_STORE_ID` secret override. In Cloudflare Workers, a `FASTLY_STORE_ID` secret shadows the checked-in `[vars]` value. If the checked-in store id should be used, remove the stale override:

```bash
npx wrangler secret delete FASTLY_STORE_ID
```

## Verify The Rotation

After updating the secret, verify that D1 to Fastly KV sync succeeds.

Use the admin backfill endpoint for an explicit result. The endpoint is paginated, so repeat the request with the returned `cursor` until `cursor` is `null` and `remaining` is `0`:

```http
POST /api/admin/sync/fastly
```

First request body:

```json
{
  "limit": 500
}
```

Follow-up request body when the response includes a cursor:

```json
{
  "limit": 500,
  "cursor": "12345"
}
```

Expected response shape:

```json
{
  "ok": true,
  "synced": 500,
  "deleted": 0,
  "failed": 0,
  "remaining": 1500,
  "cursor": "12345"
}
```

The final page returns `"cursor": null` and `"remaining": 0`. Treat the rotation as verified only after every page returns `"failed": 0`. If any page reports failures, inspect Worker logs for `Fastly API error` entries. `401` means the token value is wrong, expired, revoked, or lacks the required Fastly access.

The next hourly cron can confirm that the incremental path still runs, but it is not a full backfill. The scheduled Worker syncs recently changed users from the overlap window plus queued retry tasks, so unchanged active users are not re-pushed by cron alone.

## Runtime Sync Paths

The same secret is used by these code paths:

- Public claim flow: `src/routes/username.ts` updates D1, then writes `user:{canonical_username}` to Fastly KV with `executionCtx.waitUntil`.
- Admin assignment and revoke flow: `src/routes/admin.ts` writes or deletes Fastly KV after D1 changes.
- Admin backfill: `POST /api/admin/sync/fastly` pushes one page of active D1 usernames with pubkeys to Fastly KV and returns `failed`, `remaining`, and `cursor` fields for paging through the full backfill.
- Hourly cron: `src/index.ts` incrementally syncs recently changed D1 usernames and queued retry tasks to Fastly KV every hour.
- Vine import script: `scripts/import-vine-users.ts` has a separate one-off sync path that reads `FASTLY_API_TOKEN` and `FASTLY_STORE_ID` from the archived vines publisher `.env` file.

The mutation paths are intentionally non-blocking. A user or admin request can succeed even if the Fastly write fails later, so use the admin backfill endpoint or logs to confirm the rotation.

## Rollback

If the automation token fails and the old personal token still works, rerun:

```bash
npx wrangler secret put FASTLY_API_TOKEN
```

Paste the previous token, then rerun the paginated `POST /api/admin/sync/fastly` verification until `cursor` is `null`. Treat this as temporary; the final state should be an automation token, not a personal token.

## Follow-Up: `divine-name-sync`

The Fastly Compute service `divine-name-sync` was discovered during investigation. It is not referenced by this repository. Decide separately whether to decommission it or finish wiring it as a webhook-based sync path.

Do not change the Worker secret rotation plan based on `divine-name-sync`; the current production sync path is D1 to Fastly KV through the Cloudflare Worker.
