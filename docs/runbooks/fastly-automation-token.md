# Fastly Automation Token Rotation

This runbook replaces the temporary personal `FASTLY_API_TOKEN` Cloudflare Worker secret with a Fastly automation token for the `divine-names` KV sync path.

## Why This Matters

`divine-name-server` writes username records from D1 into Fastly KV so Divine edge routing can resolve names without querying D1. A personal Fastly token can expire or disappear with a user account, which silently breaks the async sync path.

## Token Requirements

Only a Fastly superuser can create the replacement token.

Use these settings:

- Token type: automation token
- Scope: global scope
- Access: all services
- Expiration: no expiration, or the longest approved lifetime if policy requires one

Fastly KV Store writes use account-level APIs, so a service-limited token is not sufficient.

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

Use the admin backfill endpoint for an explicit result:

```http
POST /api/admin/sync/fastly
```

Expected result:

```json
{
  "ok": true,
  "failed": 0
}
```

If the endpoint reports failures, inspect Worker logs for `Fastly API error` entries. `401` means the token value is wrong, expired, revoked, or lacks the required Fastly access.

You can also verify passively after the next hourly cron run. The scheduled Worker reconciles all active D1 users to Fastly KV once per hour and logs the number synced and failed.

## Runtime Sync Paths

The same secret is used by these code paths:

- Public claim flow: `src/routes/username.ts` updates D1, then writes `user:{canonical_username}` to Fastly KV with `executionCtx.waitUntil`.
- Admin assignment and revoke flow: `src/routes/admin.ts` writes or deletes Fastly KV after D1 changes.
- Admin backfill: `POST /api/admin/sync/fastly` pushes all active D1 usernames to Fastly KV and returns failure counts.
- Hourly cron: `src/index.ts` reconciles all active D1 usernames to Fastly KV every hour.
- Vine import script: `scripts/import-vine-users.ts` has a separate one-off sync path that reads `FASTLY_API_TOKEN` and `FASTLY_STORE_ID` from the archived vines publisher `.env` file.

The mutation paths are intentionally non-blocking. A user or admin request can succeed even if the Fastly write fails later, so use the admin backfill endpoint or logs to confirm the rotation.

## Rollback

If the automation token fails and the old personal token still works, rerun:

```bash
npx wrangler secret put FASTLY_API_TOKEN
```

Paste the previous token, then rerun `POST /api/admin/sync/fastly`. Treat this as temporary; the final state should be an automation token, not a personal token.

## Follow-Up: `divine-name-sync`

The Fastly Compute service `divine-name-sync` was discovered during investigation. It is not referenced by this repository. Decide separately whether to decommission it or finish wiring it as a webhook-based sync path.

Do not change the Worker secret rotation plan based on `divine-name-sync`; the current production sync path is D1 to Fastly KV through the Cloudflare Worker.
