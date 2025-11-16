# Divine Name Server

Cloudflare Worker that enables username-based Nostr identities at Divine.Video with NIP-05 verification and subdomain profile routing.

## Features

- **Username Claiming**: Users claim usernames via NIP-98 signed HTTP requests proving key ownership
- **Subdomain Profiles**: `https://alice.divine.video/` serves user profiles by proxying to main app
- **NIP-05 Verification**: Nostr identity verification at both root and subdomain `/.well-known/nostr.json` endpoints
- **Admin Management**: Reserve, revoke, burn, or assign usernames with status tracking
- **Relay Hints**: Store and serve up to 50 relay hints per user for better discoverability
- **One Username Per Pubkey**: Database constraints ensure each pubkey has only one active username
- **Recyclable Usernames**: Revoked usernames can be reclaimed; burned usernames are permanent

## Tech Stack

- **Hono**: Lightweight web framework optimized for Cloudflare Workers
- **Cloudflare D1**: SQLite-based edge database for username registry
- **NIP-98**: HTTP authentication via Nostr event signatures using `@noble/secp256k1`
- **TypeScript**: Type-safe implementation with Cloudflare Workers types

## Development

### Prerequisites

- Node.js 18+
- npm or similar package manager
- Cloudflare account with Workers and D1 enabled

### Setup

```bash
# Install dependencies
npm install

# Apply database migrations locally
npx wrangler d1 migrations apply divine-name-server-db --local
```

### Local Development

```bash
# Start development server
npx wrangler dev

# Server runs at http://localhost:8787
```

### Testing

```bash
# Run tests in watch mode
npm test

# Run tests once
npm test:once
```

### Deployment

```bash
# Apply migrations to production database
npx wrangler d1 migrations apply divine-name-server-db --remote

# Deploy worker to Cloudflare
npx wrangler deploy
```

## API Endpoints

### POST /api/username/claim

Claim a username with NIP-98 authentication.

**Authentication**: NIP-98 signed HTTP request

**Headers:**
```
Authorization: Nostr <base64-encoded-event>
```

The NIP-98 event must be kind 27235 with:
- `method` tag matching `POST`
- `u` tag matching the full request URL
- Timestamp within 60 seconds of current time

**Request Body:**
```json
{
  "name": "alice",
  "relays": ["wss://relay.damus.io", "wss://nos.lol"]
}
```

Fields:
- `name` (required): Username to claim (3-20 chars, lowercase alphanumeric)
- `relays` (optional): Array of relay URLs (max 50, must be wss:// protocol)

**Success Response (200):**
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

**Error Responses:**
- `400`: Invalid username format or relay validation failed
- `401`: Missing or invalid NIP-98 signature
- `403`: Username is reserved or burned
- `409`: Username already claimed by another pubkey
- `500`: Internal server error

### GET /.well-known/nostr.json

NIP-05 identity verification endpoint. Behavior differs based on hostname.

#### Subdomain Request

When accessed via subdomain (e.g., `https://alice.divine.video/.well-known/nostr.json`):

**Response (200):**
```json
{
  "names": {
    "_": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
  },
  "relays": {
    "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d": [
      "wss://relay.damus.io",
      "wss://nos.lol"
    ]
  }
}
```

Returns a single user mapping with underscore (`_`) name for NIP-05 subdomain verification.

#### Root Domain Request

When accessed via root domain (e.g., `https://divine.video/.well-known/nostr.json`):

**Response (200):**
```json
{
  "names": {
    "alice": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
    "bob": "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2"
  },
  "relays": {
    "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d": ["wss://relay.damus.io"],
    "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2": ["wss://relay.primal.net"]
  }
}
```

Returns all active username mappings for the domain.

**Headers:**
```
Cache-Control: public, max-age=60
```

### GET https://\<username\>.divine.video/

Subdomain profile routing. Proxies to the main Divine.Video application's profile page.

**Behavior:**
- Active username: Proxies request to `https://divine.video/profile/<npub>`
- Inactive/missing username: Returns 404 with user-friendly message
- Converts hex pubkey to npub (Bech32) format for profile URL

**Example:**
- Request: `https://alice.divine.video/`
- Proxies to: `https://divine.video/profile/npub180c...`

### Admin Endpoints (Protected by Cloudflare Access)

All admin endpoints require Cloudflare Access authentication configured at the edge.

#### POST /api/admin/username/reserve

Reserve a username to prevent user claims (e.g., brand protection).

**Request Body:**
```json
{
  "name": "brandname",
  "reason": "Brand protection"
}
```

**Response (200):**
```json
{
  "ok": true,
  "name": "brandname",
  "status": "reserved"
}
```

#### POST /api/admin/username/revoke

Revoke or permanently burn a username.

**Request Body:**
```json
{
  "name": "badname",
  "burn": true
}
```

Fields:
- `name` (required): Username to revoke
- `burn` (optional): If true, permanently burns the name; if false, makes it recyclable

**Response (200):**
```json
{
  "ok": true,
  "name": "badname",
  "status": "burned",
  "recyclable": false
}
```

#### POST /api/admin/username/assign

Directly assign a username to a pubkey, bypassing normal claim flow.

**Request Body:**
```json
{
  "name": "famousviner",
  "pubkey": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
}
```

**Response (200):**
```json
{
  "ok": true,
  "name": "famousviner",
  "pubkey": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "status": "active"
}
```

## Database Schema

See `migrations/0001_initial_schema.sql` for complete schema definition.

### Tables

#### usernames

Primary table mapping usernames to Nostr pubkeys.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key, auto-increment |
| name | TEXT | Unique username (3-20 lowercase alphanumeric chars) |
| pubkey | TEXT | Hex-encoded Nostr public key |
| relays | TEXT | JSON array of relay URLs (max 50) |
| status | TEXT | Status: 'active', 'reserved', 'revoked', 'burned' |
| recyclable | INTEGER | Whether name can be reclaimed (0 or 1) |
| created_at | INTEGER | Unix timestamp of creation |
| updated_at | INTEGER | Unix timestamp of last update |
| claimed_at | INTEGER | Unix timestamp when claimed by user |
| revoked_at | INTEGER | Unix timestamp when revoked |
| reserved_reason | TEXT | Admin reason for reservation |
| admin_notes | TEXT | Admin notes about username |

**Indexes:**
- `idx_usernames_pubkey_active`: Unique partial index ensuring one active username per pubkey
- `idx_usernames_status`: Index on status for fast filtered queries

#### reserved_words

Protected words that cannot be claimed as usernames.

| Column | Type | Description |
|--------|------|-------------|
| word | TEXT | Reserved word (primary key) |
| category | TEXT | Category: 'system', 'brand', 'protocol', 'app', 'subdomain' |
| reason | TEXT | Human-readable reason for reservation |
| created_at | INTEGER | Unix timestamp of creation |

**Indexes:**
- `idx_reserved_words_category`: Index on category for fast lookups

See `migrations/0002_seed_reserved_words.sql` for the initial list of 30+ reserved words.

### Status Values

- **active**: Currently claimed and in use
- **reserved**: Admin-reserved, cannot be claimed by users
- **revoked**: Freed up and reclaimable (recyclable = 1)
- **burned**: Permanently unavailable (recyclable = 0)

## Username Rules

Usernames must meet these requirements:

- **Length**: 3-20 characters
- **Characters**: Lowercase letters (a-z) and numbers (0-9) only
- **Reserved words**: Cannot use system routes, brand names, or protocol terms
- **Uniqueness**: Each username can only be active for one pubkey at a time
- **One per pubkey**: Each pubkey can only have one active username
- **Auto-revocation**: Claiming a new username automatically revokes the old one

**Valid examples**: `alice`, `bob123`, `user2024`

**Invalid examples**:
- `ab` (too short)
- `thisusernameiswaytoolong` (too long)
- `Alice` (uppercase letters)
- `alice_bob` (special characters)
- `api` (reserved word)

## Relay Validation

Relay hints are optional but must meet these requirements when provided:

- **Protocol**: Must use `wss://` (secure WebSocket)
- **Count**: Maximum 50 relays per username
- **Length**: Each relay URL must be ≤200 characters
- **Format**: Must be valid URLs per URL standard

**Valid examples**:
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.primal.net`

**Invalid examples**:
- `https://relay.com` (wrong protocol)
- `ws://relay.com` (insecure WebSocket)
- `not-a-url` (invalid format)

## Architecture Overview

The Divine Name Server is a standalone Cloudflare Worker that handles three main flows:

### 1. Username Claiming Flow

```
User → NIP-98 Signed Request → Worker
                                   ↓
                           Verify Signature
                                   ↓
                          Validate Username
                                   ↓
                          Check Reserved Words
                                   ↓
                       Query D1 for Conflicts
                                   ↓
                     Auto-revoke Old Username
                                   ↓
                      Insert/Update New Claim
                                   ↓
                      Return Profile URLs
```

### 2. Subdomain Profile Routing

```
User → alice.divine.video/ → Worker
                                ↓
                       Extract Subdomain
                                ↓
                        Query D1 by Name
                                ↓
                       Convert Hex to Npub
                                ↓
              Proxy to divine.video/profile/<npub>
                                ↓
                        Return Profile Page
```

### 3. NIP-05 Identity Verification

```
Nostr Client → /.well-known/nostr.json → Worker
                                            ↓
                                    Detect Hostname
                                            ↓
                           Subdomain? → Query Single User
                              OR
                             Root? → Query All Active Users
                                            ↓
                                  Format NIP-05 Response
                                            ↓
                              Cache for 60 seconds, Return
```

### Key Design Decisions

- **Standalone Worker**: Independent from main Divine.Video application for scalability
- **Edge Database**: D1 database for low-latency username lookups
- **NIP-98 Auth**: Cryptographic proof of key ownership, no session state needed
- **Proxy Pattern**: Subdomain routing proxies to existing profile pages, avoiding duplication
- **Reserved Words**: Pre-seeded list protects system routes and brand names
- **Status State Machine**: Clear state transitions (active → revoked → recyclable)

## NIP-05 Compatibility

The service provides three NIP-05 identity formats:

1. **Standard format**: `alice@divine.video`
   - Resolved via `divine.video/.well-known/nostr.json`
   - Works in all NIP-05 compatible clients

2. **Subdomain format**: `_@alice.divine.video`
   - Resolved via `alice.divine.video/.well-known/nostr.json`
   - NIP-05 spec compliant using underscore name

3. **Display format**: `@alice.divine.video`
   - Clean Bluesky-style display (not directly resolvable)
   - Maps to subdomain format for verification

All formats identify the same pubkey and support optional relay hints.

## Design Documentation

For complete technical design, architecture decisions, and implementation details, see:

**[docs/plans/2025-11-15-divine-name-server-implementation.md](/Users/rabble/code/andotherstuff/divine-name-server/docs/plans/2025-11-15-divine-name-server-implementation.md)**

This plan includes:
- Detailed task breakdown with acceptance criteria
- NIP-98 verification implementation
- Database migration steps
- API endpoint specifications
- Testing strategies
- Deployment procedures

## Security Considerations

- **Cryptographic Authentication**: All username claims require valid NIP-98 signatures proving key ownership
- **Admin Protection**: Admin endpoints protected by Cloudflare Access at the edge
- **No Session State**: Stateless authentication eliminates session hijacking risks
- **Namespace Protection**: Reserved words prevent claiming system routes and brand names
- **Permanent Burning**: Offensive or abusive names can be permanently disabled
- **No Hijacking**: Database constraints prevent claiming names owned by other pubkeys
- **Time-bound Requests**: NIP-98 events expire after 60 seconds to prevent replay attacks

## License

MIT
