# Divine Name Server - Technical Design

**Date:** 2025-11-15
**Owner:** Rabble
**Status:** Approved for Implementation

## Overview

The divine-name-server is a Cloudflare Worker that enables users to claim human-readable usernames as Nostr identities at Divine.Video. Each claimed username becomes:
- A subdomain: `https://<username>.divine.video/`
- A Nostr identity: `@<username>.divine.video` (with NIP-05 verification)

This provides a clean, Bluesky-style identity layer without introducing centralized user accounts.

## Architecture

### High-Level Design

The system consists of a standalone Cloudflare Worker with three core responsibilities:

1. **Subdomain Profile Serving**: `https://alice.divine.video/` → proxies to `https://divine.video/profile/<npub>` on the main React app
2. **Username Claiming API**: `/api/username/claim` endpoint for NIP-98 authenticated claims
3. **NIP-05 Identity Resolution**: `/.well-known/nostr.json` endpoints for Nostr client verification

### Technology Stack

**Core Framework:**
- **Hono** - Lightweight web framework optimized for Cloudflare Workers
- **hono-nostr-auth** - NIP-98 signature verification middleware (testing on Workers)
- **@nostr/tools** - Nostr utilities for crypto and event handling (confirmed Workers-compatible)
- **TypeScript** - Type safety

**Infrastructure:**
- **Cloudflare D1** - SQLite-based serverless database
- **Cloudflare Access** - OAuth-based admin endpoint protection
- **Wrangler** - Cloudflare Workers CLI (v4.45.0)

**Fallback Plan:**
If hono-nostr-auth doesn't work on Workers, implement NIP-98 verification directly using @nostr/tools (~50-100 lines).

### Project Structure

```
divine-name-server/
├── src/
│   ├── index.ts              # Main Hono app
│   ├── routes/
│   │   ├── username.ts       # /api/username/claim
│   │   ├── admin.ts          # /api/admin/*
│   │   └── nip05.ts          # /.well-known/nostr.json
│   ├── middleware/
│   │   └── subdomain.ts      # Subdomain detection & routing
│   ├── db/
│   │   ├── schema.sql        # D1 migrations
│   │   └── queries.ts        # Database helpers
│   └── utils/
│       └── validation.ts     # Username validation rules
├── wrangler.toml             # Worker config + D1 binding
├── package.json
└── tsconfig.json
```

## Database Schema

### `usernames` Table

Stores username → pubkey mappings with status tracking.

```sql
CREATE TABLE IF NOT EXISTS usernames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pubkey TEXT,
  relays TEXT,  -- JSON array of relay URLs (max 50)
  status TEXT NOT NULL DEFAULT 'active',
  recyclable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  revoked_at INTEGER,
  reserved_reason TEXT,
  admin_notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usernames_pubkey_active
  ON usernames(pubkey)
  WHERE status='active' AND pubkey IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usernames_status
  ON usernames(status);
```

**Status Values:**
- `active` - Currently claimed and in use
- `reserved` - Admin-reserved, cannot be claimed by users
- `revoked` - Freed up, reclaimable if `recyclable=1`
- `burned` - Permanently unavailable, `recyclable=0`

**Key Behaviors:**
- UNIQUE constraint on `name` prevents duplicate usernames
- UNIQUE INDEX on `pubkey` (WHERE `status='active'`) ensures one active name per pubkey
- If user claims new name, old name is automatically revoked
- Timestamps are Unix epoch integers

### `reserved_words` Table

Prevents claiming system routes and protects brand names.

```sql
CREATE TABLE IF NOT EXISTS reserved_words (
  word TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reserved_words_category
  ON reserved_words(category);
```

**Reserved Categories:**
1. **System Routes**: `api`, `www`, `admin`, `support`, `help`, `status`, `health`, `docs`, `blog`
2. **Common Subdomains**: `mail`, `email`, `ftp`, `smtp`, `imap`, `cdn`, `static`, `assets`
3. **Application Routes**: `profile`, `user`, `users`, `settings`, `account`, `dashboard`, `upload`, `video`, `videos`
4. **Nostr Protocol**: `relay`, `relays`, `nostr`, `nip`, `nips`, `wellknown`, `well-known`
5. **Brand Protection**: `divine`, `divinevideo`, `divinedevideo`

Database will be seeded with initial reserved words during migration.

## Request Flows

### 1. Subdomain Profile Request

```
User visits https://alice.divine.video/
  ↓
Hono middleware detects subdomain → extract "alice"
  ↓
Query D1: SELECT pubkey, status FROM usernames WHERE name='alice'
  ↓
If status='active' and pubkey exists:
  → Convert pubkey to npub format (bech32)
  → Fetch from https://divine.video/profile/<npub>
  → Return response to client
  ↓
If not found/inactive:
  → Return 404 with helpful message
```

### 2. Username Claim

```
POST /api/username/claim
{
  "name": "alice",
  "relays": ["wss://relay.damus.io", "wss://nos.lol"]  // optional
}
  ↓
hono-nostr-auth middleware verifies NIP-98 signature
  ↓
Extract pubkey from verified event
  ↓
Validate name:
  - Lowercase alphanumeric [a-z0-9]
  - Length 3-20 characters
  - Check reserved_words table
  ↓
Validate relays (if provided):
  - Array of WSS URLs
  - Max 50 relays
  - Each URL starts with wss://
  - Max 200 chars per URL
  ↓
Check D1 constraints:
  - Name not already active (UNIQUE)
  - Pubkey doesn't have active name (UNIQUE INDEX)
  - Name not reserved/burned
  ↓
INSERT/UPDATE usernames table
  ↓
Return {
  ok: true,
  name: "alice",
  pubkey: "<hex>",
  profile_url: "https://alice.divine.video/",
  nip05: {
    main_domain: "alice@divine.video",
    underscore_subdomain: "_@alice.divine.video",
    host_style: "@alice.divine.video"
  }
}
```

### 3. NIP-05 Subdomain Endpoint

```
GET https://alice.divine.video/.well-known/nostr.json
  ↓
Extract subdomain "alice"
  ↓
Query D1: SELECT pubkey, relays FROM usernames
          WHERE name='alice' AND status='active'
  ↓
If found:
  → Return {
      "names": {"_": "<pubkey>"},
      "relays": {"<pubkey>": ["wss://..."]}
    }
  → Cache-Control: public, max-age=60
  ↓
If not found: 404
```

### 4. NIP-05 Root Domain Endpoint

```
GET https://divine.video/.well-known/nostr.json
  ↓
Query D1: SELECT name, pubkey, relays FROM usernames
          WHERE status='active'
  ↓
Build response:
{
  "names": {
    "alice": "<pubkey1>",
    "bob": "<pubkey2>"
  },
  "relays": {
    "<pubkey1>": ["wss://relay.damus.io"],
    "<pubkey2>": ["wss://relay.primal.net"]
  }
}
  ↓
Cache-Control: public, max-age=60
```

### 5. Admin Operations

```
POST /api/admin/username/{reserve|revoke|burn|assign}
  ↓
Cloudflare Access validates at edge (OAuth)
  ↓
If not authenticated: 401 (before hitting worker)
  ↓
If authenticated: Request reaches worker
  → No auth code needed in worker
  → Execute admin operation
  → Return success/error
```

**Admin Endpoints:**
- `POST /api/admin/username/reserve` - Mark name as reserved
- `POST /api/admin/username/revoke` - Free up name (reclaimable)
- `POST /api/admin/username/burn` - Permanently disable name
- `POST /api/admin/username/assign` - Directly assign name to pubkey

## Username Validation

**Format Rules:**
- Lowercase alphanumeric only: `[a-z0-9]`
- Length: 3-20 characters
- No leading/trailing hyphens

**Validation Flow:**
```
1. Basic format check
2. Check reserved_words table
   → If exists: 403 "Username is reserved"
3. Check usernames table
   → If active: 409 "Username already claimed"
   → If reserved/burned: 403 "Username unavailable"
   → If revoked + recyclable: Allow claim
   → If not found: Allow claim
```

## NIP-05 Extensions

The system stores and returns NIP-05 relay hints to help Nostr clients discover where to find users.

**Relay Storage:**
- Optional `relays` field in username claim request
- Stored as JSON array in D1
- Max 50 relays per user
- Each relay must be valid `wss://` URL

**NIP-05 Response:**
Both subdomain and root domain endpoints return the standard NIP-05 format with optional `relays` object.

## Error Handling

**Common Error Scenarios:**

| Error | HTTP Status | Response |
|-------|-------------|----------|
| Invalid NIP-98 signature | 401 | Unauthorized |
| Malformed request body | 400 | Bad Request |
| Username too short/long | 400 | "Username must be 3-20 characters" |
| Invalid characters | 400 | "Username must be lowercase alphanumeric" |
| Reserved word | 403 | "Username is reserved" |
| Already taken | 409 | "Username already claimed" |
| Burned username | 403 | "Username is permanently unavailable" |
| Pubkey has active name | 409 | "You already have an active username: {name}" |
| Too many relays | 400 | "Maximum 50 relays allowed" |
| Invalid relay URL | 400 | "Invalid relay URL format" |
| D1 query error | 500 | Internal Server Error (logged) |
| Subdomain not found | 404 | Helpful message |

**Race Conditions:**
Database UNIQUE constraints handle concurrent claims atomically. If two requests try to claim the same name simultaneously, one gets 409.

**Caching Strategy:**
- NIP-05 responses: `Cache-Control: public, max-age=60`
- Profile lookups: No cache (always fresh proxy)
- Consider Cloudflare Cache API for frequently accessed usernames

## Deployment

### Initial Setup

1. **D1 Database** (already created by Rabble):
   ```bash
   wrangler d1 create divine-name-server-db
   ```

2. **Configure wrangler.toml** (without routes initially):
   ```toml
   name = "divine-name-server"
   main = "src/index.ts"
   compatibility_date = "2024-01-01"

   [[d1_databases]]
   binding = "DB"
   database_name = "divine-name-server-db"
   database_id = "<generated-id>"
   ```

3. **Deploy Worker:**
   ```bash
   wrangler deploy
   ```

4. **Run Migrations:**
   ```bash
   wrangler d1 migrations apply divine-name-server-db --remote
   ```

5. **Test at workers.dev URL:**
   ```
   https://divine-name-server.<account>.workers.dev
   ```

6. **Configure Routes** (after worker is tested):
   Add to wrangler.toml:
   ```toml
   [env.production]
   routes = [
     { pattern = "*.divine.video/*", zone_name = "divine.video" },
     { pattern = "divine.video/api/username/*", zone_name = "divine.video" },
     { pattern = "divine.video/.well-known/nostr.json", zone_name = "divine.video" }
   ]
   ```
   Then deploy again.

7. **Configure Cloudflare Access:**
   Protect `/api/admin/*` routes with OAuth policy in Cloudflare dashboard.

### Environment Variables

**.dev.vars** (local development):
```
MAIN_APP_URL=http://localhost:5173
ENVIRONMENT=development
```

**Production** (Wrangler secrets):
```
MAIN_APP_URL=https://divine.video
ENVIRONMENT=production
```

### Development Workflow

1. Local dev: `wrangler dev`
2. Run local migrations: `wrangler d1 migrations apply divine-name-server-db --local`
3. Deploy: `wrangler deploy`
4. Run remote migrations: `wrangler d1 migrations apply divine-name-server-db --remote`

## Security Considerations

1. **NIP-98 Authentication**: All username claims require cryptographic proof of key ownership
2. **Admin Protection**: Cloudflare Access protects admin endpoints with OAuth at the edge
3. **No Race Conditions**: Database constraints prevent duplicate claims atomically
4. **Input Validation**: All user inputs validated before database operations
5. **Reserved Words**: System routes protected from user claims
6. **Burned Names**: Offensive/trademark names permanently disabled
7. **Relay Validation**: WSS URLs validated to prevent injection

## Open Questions / Future Enhancements

1. **Username Updates**: Should users be able to update relay list without changing name?
2. **Name Transfer**: Admin-initiated pubkey reassignment workflow
3. **Analytics**: Track claim rate, popular names, NIP-05 usage
4. **Bulk Operations**: Admin tools for bulk reserve/import
5. **Waitlist**: Reserve queue for burned/unavailable names
6. **Key Rotation**: Support for users changing pubkeys while keeping name

## Success Metrics

- Time-to-claim < 150ms P99
- Subdomain profiles load as fast as `/profile/<npub>`
- NIP-05 verification works in major Nostr apps (Damus, Amethyst, Nos, Coracle)
- Zero duplicate name claims (enforced by DB constraints)

## References

- [NIP-05 Specification](https://github.com/nostr-protocol/nips/blob/master/05.md)
- [NIP-98 HTTP Auth](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Hono Documentation](https://hono.dev/)
- [Cloudflare Workers D1](https://developers.cloudflare.com/d1/)
- [PRD: prd.md](../../prd.md)
