# Divine Name Server

A Cloudflare Worker that gives Divine members a human-readable identity: a `username` that works as a NIP-05 Nostr address, an ActivityPub/WebFinger handle, an ATProto handle, and a profile page at `username.divine.video`. One name, resolvable across the open social protocols.

The Worker owns the username registry, a public reservation and claiming flow, and an admin console. It runs on the public edge (not the ArgoCD-managed GKE stack) and mirrors its read model to Fastly KV so `divine-router` can answer identity lookups at the edge. Because it publishes the public identity model that other services consume, deploy it alongside `divine-router`, `pds.divine.video`, and `entryway.divine.video`.

## Features

- **Username claiming** — Members claim a username with a NIP-98 signed HTTP request that proves ownership of their Nostr key. No sessions, no passwords.
- **Public reservation flow** — A pre-claim reservation path (`names.divine.video`) that gates names behind a Cashu payment or an invite code, confirms ownership by email, and expires unconfirmed holds after 48 hours.
- **NIP-05 verification** — Serves `/.well-known/nostr.json` at both the root domain (`alice@divine.video`) and the per-user subdomain (`_@alice.divine.video`).
- **Subdomain profiles** — `https://alice.divine.video/` renders the Divine web app shell with the user's profile pre-injected, plus Open Graph and Twitter card tags for rich sharing.
- **ActivityPub discovery** — WebFinger and NodeInfo endpoints make `@alice@divine.video` resolvable on the fediverse and let Divine be counted as an instance.
- **ATProto handles** — Links a username to a `did:plc:` identity so `alice.divine.video` resolves as an ATProto handle (served by `divine-router` from the mirrored record).
- **Admin console** — A React admin UI plus API for reserving, revoking, burning, assigning, restoring, and tagging usernames, with search, stats, and CSV export.
- **Edge mirror** — Every change is reconciled to Fastly KV via a durable sync queue and an hourly cron, so edge reads stay consistent with the D1 source of truth.
- **One active name per pubkey** — A partial unique index guarantees each pubkey holds at most one active username; claiming a new one auto-revokes the old one.

## Architecture

The Divine Name Server is a **single Cloudflare Worker** (`src/index.ts`, built on [Hono](https://hono.dev)) that behaves differently depending on the hostname it is serving:

| Hostname | Purpose |
|----------|---------|
| `divine.video` | Root NIP-05 (`/.well-known/nostr.json`), WebFinger, NodeInfo |
| `alice.divine.video` | Per-user subdomain: profile page + subdomain NIP-05 |
| `names.divine.video` | Public landing page, reservation flow, email confirmation |
| `names.admin.divine.video` | Admin UI (React SPA) and admin API |

### Storage

- **Cloudflare D1** (`DB`) — The source of truth: the `usernames` registry, `reserved_words`, reservations, tags, and the Fastly sync queue.
- **Cloudflare KV** (`SESSION_KV`) — Keycast OAuth admin sessions.
- **Fastly KV** — An edge mirror of the active username read model, consumed by `divine-router` to answer NIP-05 and ATProto handle lookups close to the user. D1 writes are pushed to Fastly on the request path and reconciled hourly by cron.

### How identity resolves

- **Root NIP-05** — `GET https://divine.video/.well-known/nostr.json?name=alice` returns the single mapping for `alice`. The endpoint requires a `name` parameter (it does not dump the full registry) and falls back to a dot-stripped lookup for legacy dotted handles.
- **Subdomain NIP-05** — `GET https://alice.divine.video/.well-known/nostr.json` returns the user's pubkey under the reserved `_` name, with relay hints when present.
- **Subdomain profile** — `GET https://alice.divine.video/` fetches the Divine web app shell, injects `window.__DIVINE_USER__` (pubkey, npub, display name, avatar pulled from `relay.divine.video`), rewrites the OG/Twitter meta tags, and returns the HTML so the SPA can render the profile. Static assets pass through to the origin.
- **ActivityPub** — `GET /.well-known/webfinger?resource=acct:alice@divine.video` returns a JRD pointing at the user's profile and ActivityPub actor URL. `/.well-known/nodeinfo` and `/nodeinfo/2.1` advertise the instance.

Service subdomains (`names`, `www`, `login`, `pds`, `feed`, `labeler`, `relay`, `media`) are excluded from user-profile routing.

### Admin authentication

Admin API routes are guarded on two axes:

1. **Hostname guard** — Admin routes only activate on `names.admin.divine.video` (or `localhost`/`admin.localhost` in development), so the same Worker on `names.divine.video` cannot reach them.
2. **Authentication** — A request must carry either a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, injected at the edge) or a Keycast OAuth session cookie whose pubkey is in the `ADMIN_PUBKEYS` allowlist.

### Cron reconciliation

A scheduled handler runs hourly (`0 * * * *`):

1. Expires unconfirmed reservations older than 48 hours.
2. Reconciles usernames changed in the last six hours, plus anything left in the durable Fastly sync queue, into Fastly KV — syncing active names and deleting revoked/burned ones. Failures are re-queued with bounded retries.

## Getting started

### Prerequisites

- Node.js 18+
- A Cloudflare account with Workers and D1 enabled
- (Optional) [Bun](https://bun.sh) for the Vine import scripts

### Setup

```bash
# Install Worker dependencies
npm install

# Apply database migrations to the local D1 database
npx wrangler d1 migrations apply divine-name-server-db --local
```

### Local development

```bash
# Install and build the admin UI (first run, and after admin-ui/ changes)
cd admin-ui && npm install && npm run build && cd ..

# Start the Worker
npm run dev
# Worker: http://localhost:8787
# Admin UI: http://admin.localhost:8787/
```

Admin auth is enforced against the real Cloudflare Access / Keycast paths even locally. To bypass it during development, set `BYPASS_LOCAL_AUTH=true` in `.dev.vars`.

### Testing

```bash
npm test            # Vitest, watch mode
npm run test:once   # single run
```

## Configuration

Bindings and variables live in `wrangler.toml`.

### Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 database (`divine-name-server-db`) | Username registry and all persistent state |
| `SESSION_KV` | KV namespace | Keycast OAuth admin sessions |
| `ASSETS` | Static assets (`./admin-ui/dist`) | Admin UI SPA, served with `run_worker_first` |

### Variables and secrets

| Name | Kind | Purpose |
|------|------|---------|
| `KEYCAST_URL`, `KEYCAST_CLIENT_ID` | var | Keycast OAuth admin login (`login.divine.video`) |
| `ADMIN_PUBKEYS` | var | Comma-separated hex pubkeys allowed to use Keycast admin sessions |
| `FASTLY_STORE_ID` | var | Fastly KV store the edge mirror writes to |
| `FASTLY_API_TOKEN` | secret | Auth for Fastly KV sync (`wrangler secret put`) |
| `ATPROTO_SYNC_TOKEN` | secret | Bearer token for the internal ATProto sync endpoint |
| `SENDGRID_API_KEY` | secret | Sends reservation-confirmation and assignment emails |
| `ALLOWED_MINTS` | var | Comma-separated Cashu mint allowlist for paid reservations |
| `NAME_PRICE_JSON` | var | Overrides the tiered reservation pricing (JSON of length tier → sats) |
| `INVITE_FAUCET_URL` | var | Base URL of the invite-code faucet |
| `AP_ACTOR_BASE_URL` | var | Base URL for ActivityPub actor links in WebFinger responses |

Routes (Worker + zones) and the cron trigger are also declared in `wrangler.toml`.

## Deployment

```bash
# Apply migrations to the production database
npx wrangler d1 migrations apply divine-name-server-db --remote

# Build the admin UI and deploy the Worker
npm run deploy   # == npm run build:admin && wrangler deploy
```

Deploy this Worker **after** the GKE identity services are healthy: it publishes the public read model that `divine-router` and ATProto handle discovery consume.

## API reference

### Public username API (`/api/username`)

All endpoints send permissive CORS headers so the Divine web and Flutter clients can call them.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/username/check/:name` | Check availability and validate format. No auth. |
| `GET` | `/api/username/by-pubkey/:pubkey` | Look up the active username for a pubkey. No auth. |
| `POST` | `/api/username/reserve` | Reserve a name with email + Cashu payment or invite code. |
| `GET` | `/api/username/confirm` | JSON email-confirmation callback for a reservation token. |
| `POST` | `/api/username/claim` | Claim a name with NIP-98 auth. |

#### POST /api/username/claim

Claim a username by proving key ownership.

**Authentication:** a NIP-98 event (kind `27235`) sent as `Authorization: Nostr <base64-event>`, with a `u` tag matching the request URL, a `method` tag matching `POST`, and a timestamp within 60 seconds.

**Request body:**

```json
{
  "name": "alice",
  "relays": ["wss://relay.damus.io", "wss://nos.lol"]
}
```

- `name` (required) — 3–20 lowercase alphanumeric characters, not a reserved word.
- `relays` (optional) — up to 50 `wss://` relay hints.

**Success (200):**

```json
{
  "ok": true,
  "name": "alice",
  "pubkey": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "profile_url": "https://alice.divine.video/",
  "nip05": {
    "main_domain": "alice@divine.video",
    "underscore_subdomain": "_@alice.divine.video",
    "host_style": "@alice.divine.video"
  }
}
```

**Errors:** `400` invalid username/relays · `401` bad NIP-98 signature · `403` reserved or burned · `409` claimed by another pubkey · `500` internal error.

#### POST /api/username/reserve

Hold a name before claiming it. Requires an `email` plus **either** a `cashu_token` (validated against `ALLOWED_MINTS` and the tiered price for the name length) **or** an `invite_code`. Rate-limited to 5 reservations per email per hour. On success the Worker emails a confirmation link; the hold expires in 48 hours if unconfirmed.

```json
{
  "name": "alice",
  "email": "alice@example.com",
  "cashu_token": "cashuA...",
  "invite_code": "optional-instead-of-payment"
}
```

Reservation pricing is tiered by name length (shorter names cost more) with a curated premium-name list; defaults live in `src/utils/pricing.ts` and can be overridden with `NAME_PRICE_JSON`.

### NIP-05 and discovery

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/nostr.json?name=<name>` | Root NIP-05 (requires `name`, returns one mapping) |
| `GET` | `/.well-known/nostr.json` (on a subdomain) | Subdomain NIP-05, returns the `_` mapping |
| `GET` | `/.well-known/webfinger?resource=acct:<user>@divine.video` | WebFinger JRD |
| `GET` | `/.well-known/nodeinfo` | NodeInfo discovery document |
| `GET` | `/nodeinfo/2.1` | NodeInfo 2.1 document (active user count) |

**Subdomain NIP-05 (200):**

```json
{
  "names": { "_": "3bf0c63f...aefa459d" },
  "relays": { "3bf0c63f...aefa459d": ["wss://relay.damus.io", "wss://nos.lol"] }
}
```

**Root NIP-05 (200):**

```json
{
  "names": { "alice": "3bf0c63f...aefa459d" },
  "relays": { "3bf0c63f...aefa459d": ["wss://relay.damus.io"] }
}
```

All identity responses send `Cache-Control: public, max-age=60`.

### Admin API (`/api/admin`)

Guarded by the hostname + auth rules above. Highlights:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/usernames/search` | Search by name, pubkey, or status |
| `GET` | `/api/admin/usernames/stats` | Registry counts |
| `GET` | `/api/admin/username/:name` | Name detail, including tags |
| `POST` | `/api/admin/username/reserve` · `/reserve-bulk` | Reserve one or many names |
| `POST` | `/api/admin/username/revoke` | Revoke (recyclable) or burn (permanent) a name |
| `POST` | `/api/admin/username/restore` | Re-bind a revoked/burned name to a pubkey |
| `POST` | `/api/admin/username/assign` · `/assign-bulk` | Directly assign names to pubkeys |
| `POST` | `/api/admin/username/set-atproto` | Set a name's `did:plc:` and handle-resolution state |
| `GET` | `/api/admin/username/:name/nip05-status` | Compare D1 vs Fastly KV for a name |
| `POST` | `/api/admin/username/:name/sync-to-fastly` · `/api/admin/sync/fastly` | Force edge re-sync |
| `GET` | `/api/admin/export/csv` | Export the registry as CSV |
| `GET`/`POST`/`DELETE` | `/api/admin/reserved-words[/:word]` | Manage reserved words |
| `POST`/`DELETE` | `/api/admin/username/:name/tags[/:tag]` | Manage per-name tags |
| `POST` | `/api/admin/notify-assignment` | Email a user their assigned name |

Admin sessions are established via the Keycast OAuth flow under `/api/admin/auth/` (`start`, `callback`, `status`, `logout`).

#### Username lifecycle

`revoke` preserves the `pubkey` on revoked and burned rows so the moderation service can later find a banned user's names (`search?q=<pubkey>&status=burned`) and `restore` them if a ban is reversed. `restore` sets the name back to `active`, clears `revoked_at`, re-binds the pubkey (revoking any other active name that pubkey holds), appends an audited note, and re-syncs to Fastly KV. Restoring an already-`active` name returns `409` rather than silently overwriting the current owner.

#### ATProto handle resolution

`set-atproto` records a `did:plc:` and a lifecycle `atproto_state` (`pending`, `ready`, `failed`, `disabled`, or `null`). The record is mirrored to Fastly KV, and `divine-router` serves `/.well-known/atproto-did` only when the name is `active`, the state is `ready`, and a DID is present. The user's PDS-managed DID document must also list `alsoKnownAs: ["at://username.divine.video"]` for bidirectional verification. This Worker does not mint or manage DIDs.

### Internal API (`/api/internal`)

`POST /api/internal/username/set-atproto` — service-to-service variant of the ATProto linking endpoint, authenticated with the `ATPROTO_SYNC_TOKEN` bearer token.

## Database schema

Migrations under `migrations/` define and evolve the schema (`0001_initial_schema.sql` onward). The core tables:

### usernames

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `name` / `username_display` | TEXT | Display form of the username |
| `username_canonical` | TEXT | Canonical (lowercased, punycode) form used for lookups |
| `pubkey` | TEXT | Hex Nostr public key |
| `relays` | TEXT | JSON array of relay hints (max 50) |
| `status` | TEXT | `active`, `reserved`, `revoked`, `burned`, `pending-confirmation` |
| `recyclable` | INTEGER | Whether a freed name can be reclaimed |
| `atproto_did` / `atproto_state` | TEXT | ATProto handle linkage |
| `created_at` / `updated_at` / `claimed_at` / `revoked_at` | INTEGER | Unix timestamps |
| `reserved_reason` / `admin_notes` | TEXT | Admin metadata |

A partial unique index enforces one `active` name per pubkey.

### reserved_words

Protected words (system routes, brand and protocol terms) that cannot be claimed, seeded by `0002_seed_reserved_words.sql` and editable via the admin API.

Additional tables cover reservations, spent Cashu proofs, username tags, and the Fastly sync queue — see the corresponding migrations.

## Username and relay rules

**Usernames:** 3–20 characters, lowercase letters and digits only, not a reserved word, unique per active pubkey. Claiming a new name auto-revokes the old one.

**Relay hints:** optional; when present, each must be a valid `wss://` URL of at most 200 characters, with at most 50 per name.

## NIP-05 formats

The service exposes the same pubkey in three forms:

1. `alice@divine.video` — standard NIP-05, resolved at the root domain.
2. `_@alice.divine.video` — subdomain NIP-05 using the reserved `_` name.
3. `@alice.divine.video` — Bluesky-style display form, verified via the subdomain format.

## Security notes

- **Cryptographic claims** — Every claim requires a valid, time-bound NIP-98 signature; there is no session state to hijack.
- **Gated reservations** — Public reservations require payment or an invite code, are rate-limited per email, and are confirmed by email before activation.
- **Admin defense in depth** — A hostname guard plus Cloudflare Access or an allowlisted Keycast session protect every admin route.
- **Namespace protection** — Reserved words and service subdomains keep system routes and brand names unclaimable; burned names are permanently unavailable.
- **No hijacking** — A partial unique index prevents taking over a name owned by another pubkey.

## Documentation

Design and rollout notes live under `docs/` (see `docs/plans/` and `docs/superpowers/`). `AGENTS.md` documents contributor and PR conventions.

## License

MIT

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
