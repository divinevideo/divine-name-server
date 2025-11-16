# Divine Name Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Cloudflare Worker that enables username-based Nostr identities at Divine.Video with NIP-05 verification.

**Architecture:** Standalone Hono-based Cloudflare Worker with D1 database. Handles subdomain routing, username claims via NIP-98, and serves NIP-05 endpoints. Proxies profile requests to main React app.

**Tech Stack:** TypeScript, Hono (web framework), hono-nostr-auth (NIP-98), @nostr/tools (Nostr utilities), Cloudflare Workers + D1

---

## Task 1: Project Initialization

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `.gitignore`
- Create: `src/index.ts`

**Step 1: Initialize Node.js project**

```bash
npm init -y
```

Expected: Creates `package.json`

**Step 2: Install dependencies**

```bash
npm install hono
npm install --save-dev wrangler typescript @cloudflare/workers-types
```

Expected: Dependencies installed, package-lock.json created

**Step 3: Try installing hono-nostr-auth**

```bash
npm install hono-nostr-auth
```

If this fails or doesn't exist, note it for later (we'll implement NIP-98 manually if needed).

**Step 4: Install Nostr tools**

```bash
npm install @noble/secp256k1 @scure/base
```

These are the core crypto libraries we need for NIP-98 verification.

**Step 5: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ES2022",
    "lib": ["ES2021"],
    "moduleResolution": "node",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

**Step 6: Create wrangler config**

Create `wrangler.toml`:

```toml
name = "divine-name-server"
main = "src/index.ts"
compatibility_date = "2024-11-15"

[[d1_databases]]
binding = "DB"
database_name = "divine-name-server-db"
database_id = "REPLACE_WITH_ACTUAL_ID"
```

Note: Replace `database_id` with the actual ID from Rabble's D1 database.

**Step 7: Create .gitignore**

Create `.gitignore`:

```
node_modules/
dist/
.wrangler/
.dev.vars
*.log
.DS_Store
```

**Step 8: Create minimal Hono app**

Create `src/index.ts`:

```typescript
// ABOUTME: Main entry point for divine-name-server Cloudflare Worker
// ABOUTME: Handles username claiming, subdomain routing, and NIP-05 endpoints

import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

export default app
```

**Step 9: Test local dev server**

```bash
npx wrangler dev
```

Expected: Server starts, visit `http://localhost:8787/` and see JSON response.
Press Ctrl+C to stop.

**Step 10: Commit**

```bash
git add .
git commit -m "feat: initialize Hono project with TypeScript and Wrangler

- Set up package.json with Hono and Cloudflare Workers deps
- Configure TypeScript for Workers environment
- Create basic Hono app with health check endpoint
- Configure wrangler for D1 database binding

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Database Schema & Migrations

**Files:**
- Create: `migrations/0001_initial_schema.sql`
- Create: `migrations/0002_seed_reserved_words.sql`

**Step 1: Create migrations directory**

```bash
mkdir -p migrations
```

**Step 2: Create initial schema migration**

Create `migrations/0001_initial_schema.sql`:

```sql
-- ABOUTME: Initial database schema for usernames and reserved words
-- ABOUTME: Creates tables with constraints to enforce one active name per pubkey

-- Usernames table: maps username to pubkey with status tracking
CREATE TABLE IF NOT EXISTS usernames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pubkey TEXT,
  relays TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  recyclable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  revoked_at INTEGER,
  reserved_reason TEXT,
  admin_notes TEXT
);

-- Ensure one active name per pubkey
CREATE UNIQUE INDEX IF NOT EXISTS idx_usernames_pubkey_active
  ON usernames(pubkey)
  WHERE status='active' AND pubkey IS NOT NULL;

-- Fast lookups by status
CREATE INDEX IF NOT EXISTS idx_usernames_status
  ON usernames(status);

-- Reserved words table: prevents claiming system routes
CREATE TABLE IF NOT EXISTS reserved_words (
  word TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- Fast lookups by category
CREATE INDEX IF NOT EXISTS idx_reserved_words_category
  ON reserved_words(category);
```

**Step 3: Create reserved words seed migration**

Create `migrations/0002_seed_reserved_words.sql`:

```sql
-- ABOUTME: Seeds reserved words to protect system routes and brand names

INSERT OR IGNORE INTO reserved_words (word, category, reason, created_at) VALUES
-- System routes
('api', 'system', 'API endpoint root', unixepoch()),
('www', 'system', 'WWW subdomain', unixepoch()),
('admin', 'system', 'Admin interface', unixepoch()),
('support', 'system', 'Support pages', unixepoch()),
('help', 'system', 'Help documentation', unixepoch()),
('status', 'system', 'Status page', unixepoch()),
('health', 'system', 'Health check', unixepoch()),
('docs', 'system', 'Documentation', unixepoch()),
('blog', 'system', 'Blog', unixepoch()),

-- Common subdomains
('mail', 'subdomain', 'Email server', unixepoch()),
('email', 'subdomain', 'Email service', unixepoch()),
('ftp', 'subdomain', 'FTP server', unixepoch()),
('smtp', 'subdomain', 'SMTP server', unixepoch()),
('imap', 'subdomain', 'IMAP server', unixepoch()),
('cdn', 'subdomain', 'CDN', unixepoch()),
('static', 'subdomain', 'Static assets', unixepoch()),
('assets', 'subdomain', 'Asset server', unixepoch()),

-- Application routes
('profile', 'app', 'Profile pages', unixepoch()),
('user', 'app', 'User pages', unixepoch()),
('users', 'app', 'Users directory', unixepoch()),
('settings', 'app', 'Settings page', unixepoch()),
('account', 'app', 'Account management', unixepoch()),
('dashboard', 'app', 'Dashboard', unixepoch()),
('upload', 'app', 'Upload endpoint', unixepoch()),
('video', 'app', 'Video pages', unixepoch()),
('videos', 'app', 'Videos directory', unixepoch()),

-- Nostr protocol
('relay', 'protocol', 'Nostr relay', unixepoch()),
('relays', 'protocol', 'Relay directory', unixepoch()),
('nostr', 'protocol', 'Nostr protocol', unixepoch()),
('nip', 'protocol', 'Nostr protocol spec', unixepoch()),
('nips', 'protocol', 'Nostr protocol specs', unixepoch()),
('wellknown', 'protocol', 'Well-known directory', unixepoch()),

-- Brand protection
('divine', 'brand', 'Brand name', unixepoch()),
('divinevideo', 'brand', 'Brand name variation', unixepoch()),
('divinedevideo', 'brand', 'Common typo', unixepoch());
```

**Step 4: Apply migrations locally**

```bash
npx wrangler d1 migrations apply divine-name-server-db --local
```

Expected: Output shows tables created successfully.

**Step 5: Verify tables created**

```bash
npx wrangler d1 execute divine-name-server-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Expected: Shows `usernames` and `reserved_words` tables.

**Step 6: Verify reserved words seeded**

```bash
npx wrangler d1 execute divine-name-server-db --local --command "SELECT COUNT(*) as count FROM reserved_words"
```

Expected: Shows count > 0 (should be ~30 words).

**Step 7: Commit**

```bash
git add migrations/
git commit -m "feat: add database schema and reserved words

- Create usernames table with status tracking
- Add unique constraints for name and active pubkey
- Create reserved_words table for system route protection
- Seed 30+ reserved words (system, brand, protocol)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Username Validation Utilities

**Files:**
- Create: `src/utils/validation.ts`
- Create: `src/utils/validation.test.ts`

**Step 1: Write failing tests**

Create `src/utils/validation.test.ts`:

```typescript
// ABOUTME: Tests for username validation logic
// ABOUTME: Ensures usernames meet format requirements and aren't reserved

import { describe, it, expect } from 'vitest'
import { validateUsername, UsernameValidationError } from './validation'

describe('validateUsername', () => {
  it('should accept valid lowercase alphanumeric usernames', () => {
    expect(() => validateUsername('alice')).not.toThrow()
    expect(() => validateUsername('bob123')).not.toThrow()
    expect(() => validateUsername('user2024')).not.toThrow()
  })

  it('should reject usernames shorter than 3 characters', () => {
    expect(() => validateUsername('ab')).toThrow(UsernameValidationError)
    expect(() => validateUsername('ab')).toThrow('must be 3-20 characters')
  })

  it('should reject usernames longer than 20 characters', () => {
    expect(() => validateUsername('a'.repeat(21))).toThrow(UsernameValidationError)
    expect(() => validateUsername('a'.repeat(21))).toThrow('must be 3-20 characters')
  })

  it('should reject usernames with uppercase letters', () => {
    expect(() => validateUsername('Alice')).toThrow(UsernameValidationError)
    expect(() => validateUsername('Alice')).toThrow('lowercase alphanumeric')
  })

  it('should reject usernames with special characters', () => {
    expect(() => validateUsername('alice_123')).toThrow(UsernameValidationError)
    expect(() => validateUsername('alice-bob')).toThrow(UsernameValidationError)
    expect(() => validateUsername('alice.bob')).toThrow(UsernameValidationError)
  })

  it('should reject empty usernames', () => {
    expect(() => validateUsername('')).toThrow(UsernameValidationError)
  })
})
```

**Step 2: Install test dependencies**

```bash
npm install --save-dev vitest
```

**Step 3: Add test script to package.json**

Edit `package.json`, add to `"scripts"`:

```json
"scripts": {
  "test": "vitest",
  "test:once": "vitest run"
}
```

**Step 4: Run tests to verify they fail**

```bash
npm test -- --run
```

Expected: Tests fail with "Cannot find module './validation'"

**Step 5: Write minimal implementation**

Create `src/utils/validation.ts`:

```typescript
// ABOUTME: Username validation utilities for format checking
// ABOUTME: Enforces 3-20 char lowercase alphanumeric requirement

export class UsernameValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsernameValidationError'
  }
}

export function validateUsername(username: string): void {
  if (!username || username.length === 0) {
    throw new UsernameValidationError('Username is required')
  }

  if (username.length < 3 || username.length > 20) {
    throw new UsernameValidationError('Username must be 3-20 characters')
  }

  const validPattern = /^[a-z0-9]+$/
  if (!validPattern.test(username)) {
    throw new UsernameValidationError('Username must be lowercase alphanumeric')
  }
}
```

**Step 6: Run tests to verify they pass**

```bash
npm test -- --run
```

Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/utils/
git commit -m "feat: add username validation utilities

- Implement validateUsername with format checks
- Enforce 3-20 char lowercase alphanumeric requirement
- Add comprehensive test suite with edge cases

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Relay URL Validation

**Files:**
- Modify: `src/utils/validation.ts`
- Modify: `src/utils/validation.test.ts`

**Step 1: Write failing tests**

Add to `src/utils/validation.test.ts`:

```typescript
import { validateRelays, RelayValidationError } from './validation'

describe('validateRelays', () => {
  it('should accept null relays', () => {
    expect(() => validateRelays(null)).not.toThrow()
  })

  it('should accept empty array', () => {
    expect(() => validateRelays([])).not.toThrow()
  })

  it('should accept valid wss URLs', () => {
    const relays = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net'
    ]
    expect(() => validateRelays(relays)).not.toThrow()
  })

  it('should reject non-wss URLs', () => {
    expect(() => validateRelays(['https://example.com'])).toThrow(RelayValidationError)
    expect(() => validateRelays(['ws://relay.com'])).toThrow(RelayValidationError)
  })

  it('should reject more than 50 relays', () => {
    const tooMany = Array(51).fill('wss://relay.com')
    expect(() => validateRelays(tooMany)).toThrow(RelayValidationError)
    expect(() => validateRelays(tooMany)).toThrow('Maximum 50 relays')
  })

  it('should reject URLs longer than 200 characters', () => {
    const longUrl = 'wss://' + 'a'.repeat(200) + '.com'
    expect(() => validateRelays([longUrl])).toThrow(RelayValidationError)
  })

  it('should reject invalid URL format', () => {
    expect(() => validateRelays(['not a url'])).toThrow(RelayValidationError)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npm test -- --run
```

Expected: Tests fail with "Cannot find name 'validateRelays'"

**Step 3: Implement relay validation**

Add to `src/utils/validation.ts`:

```typescript
export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayValidationError'
  }
}

export function validateRelays(relays: string[] | null): void {
  if (relays === null || relays === undefined) {
    return
  }

  if (!Array.isArray(relays)) {
    throw new RelayValidationError('Relays must be an array')
  }

  if (relays.length === 0) {
    return
  }

  if (relays.length > 50) {
    throw new RelayValidationError('Maximum 50 relays allowed')
  }

  for (const relay of relays) {
    if (typeof relay !== 'string') {
      throw new RelayValidationError('Relay must be a string')
    }

    if (relay.length > 200) {
      throw new RelayValidationError('Relay URL too long (max 200 characters)')
    }

    if (!relay.startsWith('wss://')) {
      throw new RelayValidationError('Relay must be a wss:// URL')
    }

    // Basic URL validation
    try {
      new URL(relay)
    } catch {
      throw new RelayValidationError('Invalid relay URL format')
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --run
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/utils/validation.ts src/utils/validation.test.ts
git commit -m "feat: add relay URL validation

- Implement validateRelays with format checking
- Enforce wss:// protocol and 50 relay limit
- Add comprehensive test coverage

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: NIP-98 Verification (Manual Implementation)

**Note:** We're implementing NIP-98 manually since hono-nostr-auth compatibility is uncertain.

**Files:**
- Create: `src/middleware/nip98.ts`
- Create: `src/middleware/nip98.test.ts`

**Step 1: Write failing test**

Create `src/middleware/nip98.test.ts`:

```typescript
// ABOUTME: Tests for NIP-98 HTTP authentication verification
// ABOUTME: Validates Nostr event signatures on HTTP requests

import { describe, it, expect } from 'vitest'
import { verifyNip98Event } from './nip98'

describe('verifyNip98Event', () => {
  it('should reject if Authorization header missing', async () => {
    const headers = new Headers()
    await expect(verifyNip98Event(headers, 'GET', 'https://example.com/api'))
      .rejects.toThrow('Missing Authorization header')
  })

  it('should reject if not Nostr auth scheme', async () => {
    const headers = new Headers()
    headers.set('Authorization', 'Bearer token123')
    await expect(verifyNip98Event(headers, 'GET', 'https://example.com/api'))
      .rejects.toThrow('Invalid Authorization scheme')
  })

  // More comprehensive tests would require generating valid Nostr events
  // For now, we verify the basic structure works
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run
```

Expected: Fails with "Cannot find module './nip98'"

**Step 3: Implement NIP-98 verification**

Create `src/middleware/nip98.ts`:

```typescript
// ABOUTME: NIP-98 HTTP authentication verification middleware
// ABOUTME: Validates Nostr event signatures for API authentication

import { schnorr } from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/secp256k1'

export class Nip98Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Nip98Error'
  }
}

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function sha256(data: Uint8Array): Promise<Uint8Array> {
  return crypto.subtle.digest('SHA-256', data).then(buf => new Uint8Array(buf))
}

async function calculateEventId(event: NostrEvent): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
  const hash = await sha256(new TextEncoder().encode(serialized))
  return bytesToHex(hash)
}

export async function verifyNip98Event(
  headers: Headers,
  method: string,
  url: string
): Promise<string> {
  const authHeader = headers.get('Authorization')

  if (!authHeader) {
    throw new Nip98Error('Missing Authorization header')
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Nostr') {
    throw new Nip98Error('Invalid Authorization scheme, expected: Nostr <base64-event>')
  }

  let event: NostrEvent
  try {
    const eventJson = atob(parts[1])
    event = JSON.parse(eventJson)
  } catch {
    throw new Nip98Error('Invalid base64 or JSON in Authorization header')
  }

  // Verify event structure
  if (event.kind !== 27235) {
    throw new Nip98Error('Invalid event kind, expected 27235 for NIP-98')
  }

  // Verify event ID
  const calculatedId = await calculateEventId(event)
  if (calculatedId !== event.id) {
    throw new Nip98Error('Event ID does not match calculated hash')
  }

  // Verify signature
  try {
    const isValid = await schnorr.verify(
      event.sig,
      event.id,
      event.pubkey
    )
    if (!isValid) {
      throw new Nip98Error('Invalid signature')
    }
  } catch (error) {
    throw new Nip98Error(`Signature verification failed: ${error}`)
  }

  // Verify timestamp (within 60 seconds)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - event.created_at) > 60) {
    throw new Nip98Error('Event timestamp too old or in future')
  }

  // Verify method tag
  const methodTag = event.tags.find(tag => tag[0] === 'method')
  if (!methodTag || methodTag[1] !== method) {
    throw new Nip98Error(`Method tag mismatch, expected ${method}`)
  }

  // Verify URL tag
  const urlTag = event.tags.find(tag => tag[0] === 'u')
  if (!urlTag || urlTag[1] !== url) {
    throw new Nip98Error('URL tag mismatch')
  }

  return event.pubkey
}
```

**Step 4: Run tests**

```bash
npm test -- --run
```

Expected: Tests pass (we have basic structure tests).

**Step 5: Commit**

```bash
git add src/middleware/nip98.ts src/middleware/nip98.test.ts
git commit -m "feat: implement NIP-98 HTTP authentication

- Add manual NIP-98 event verification using @noble/secp256k1
- Validate event structure, signature, timestamp, and tags
- Enforce 60-second time window for requests

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Database Query Helpers

**Files:**
- Create: `src/db/queries.ts`

**Step 1: Create database helper functions**

Create `src/db/queries.ts`:

```typescript
// ABOUTME: Database query helpers for usernames and reserved words
// ABOUTME: Provides type-safe D1 database operations

export interface Username {
  id: number
  name: string
  pubkey: string | null
  relays: string | null
  status: 'active' | 'reserved' | 'revoked' | 'burned'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
}

export async function isReservedWord(
  db: D1Database,
  word: string
): Promise<boolean> {
  const result = await db.prepare(
    'SELECT 1 FROM reserved_words WHERE word = ?'
  ).bind(word).first()

  return result !== null
}

export async function getUsernameByName(
  db: D1Database,
  name: string
): Promise<Username | null> {
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE name = ?'
  ).bind(name).first<Username>()

  return result
}

export async function getUsernameByPubkey(
  db: D1Database,
  pubkey: string
): Promise<Username | null> {
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE pubkey = ? AND status = ?'
  ).bind(pubkey, 'active').first<Username>()

  return result
}

export async function claimUsername(
  db: D1Database,
  name: string,
  pubkey: string,
  relays: string[] | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const relaysJson = relays ? JSON.stringify(relays) : null

  // First, revoke any existing active username for this pubkey
  await db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE pubkey = ? AND status = 'active'`
  ).bind(now, now, pubkey).run()

  // Then insert or update the new username
  await db.prepare(
    `INSERT INTO usernames (name, pubkey, relays, status, created_at, updated_at, claimed_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       pubkey = excluded.pubkey,
       relays = excluded.relays,
       status = 'active',
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(name, pubkey, relaysJson, now, now, now).run()
}

export async function getAllActiveUsernames(
  db: D1Database
): Promise<Username[]> {
  const result = await db.prepare(
    'SELECT * FROM usernames WHERE status = ?'
  ).bind('active').all<Username>()

  return result.results
}

export async function reserveUsername(
  db: D1Database,
  name: string,
  reason: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await db.prepare(
    `INSERT INTO usernames (name, status, reserved_reason, created_at, updated_at)
     VALUES (?, 'reserved', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       status = 'reserved',
       reserved_reason = excluded.reserved_reason,
       updated_at = excluded.updated_at`
  ).bind(name, reason, now, now).run()
}

export async function revokeUsername(
  db: D1Database,
  name: string,
  burn: boolean
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const status = burn ? 'burned' : 'revoked'
  const recyclable = burn ? 0 : 1

  await db.prepare(
    `UPDATE usernames
     SET status = ?,
         recyclable = ?,
         revoked_at = ?,
         updated_at = ?
     WHERE name = ?`
  ).bind(status, recyclable, now, now, name).run()
}

export async function assignUsername(
  db: D1Database,
  name: string,
  pubkey: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  // Revoke existing username for this pubkey
  await db.prepare(
    `UPDATE usernames
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE pubkey = ? AND status = 'active'`
  ).bind(now, now, pubkey).run()

  // Assign username
  await db.prepare(
    `INSERT INTO usernames (name, pubkey, status, created_at, updated_at, claimed_at)
     VALUES (?, ?, 'active', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       pubkey = excluded.pubkey,
       status = 'active',
       updated_at = excluded.updated_at,
       claimed_at = excluded.claimed_at`
  ).bind(name, pubkey, now, now, now).run()
}
```

**Step 2: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat: add database query helpers

- Create type-safe D1 query functions
- Implement username CRUD operations
- Add reserved word checking
- Handle automatic username revocation on new claim

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Username Claim Endpoint

**Files:**
- Create: `src/routes/username.ts`
- Modify: `src/index.ts`

**Step 1: Create username claim route**

Create `src/routes/username.ts`:

```typescript
// ABOUTME: Username claiming endpoint with NIP-98 authentication
// ABOUTME: Handles POST /api/username/claim for users to claim usernames

import { Hono } from 'hono'
import { verifyNip98Event } from '../middleware/nip98'
import { validateUsername, validateRelays, UsernameValidationError, RelayValidationError } from '../utils/validation'
import {
  isReservedWord,
  getUsernameByName,
  getUsernameByPubkey,
  claimUsername
} from '../db/queries'
import { bech32 } from '@scure/base'

type Bindings = {
  DB: D1Database
}

const username = new Hono<{ Bindings: Bindings }>()

function hexToNpub(hex: string): string {
  const data = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    data[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  const words = bech32.toWords(data)
  return bech32.encode('npub', words)
}

username.post('/claim', async (c) => {
  try {
    // Verify NIP-98 authentication
    const url = new URL(c.req.url)
    const pubkey = await verifyNip98Event(
      c.req.raw.headers,
      'POST',
      url.toString()
    )

    // Parse request body
    const body = await c.req.json<{ name: string; relays?: string[] }>()
    const { name, relays = null } = body

    // Validate username format
    try {
      validateUsername(name)
    } catch (error) {
      if (error instanceof UsernameValidationError) {
        return c.json({ ok: false, error: error.message }, 400)
      }
      throw error
    }

    // Validate relays if provided
    if (relays !== null) {
      try {
        validateRelays(relays)
      } catch (error) {
        if (error instanceof RelayValidationError) {
          return c.json({ ok: false, error: error.message }, 400)
        }
        throw error
      }
    }

    // Check if name is reserved
    const reserved = await isReservedWord(c.env.DB, name)
    if (reserved) {
      return c.json({ ok: false, error: 'Username is reserved' }, 403)
    }

    // Check if name exists
    const existing = await getUsernameByName(c.env.DB, name)
    if (existing) {
      if (existing.status === 'active' && existing.pubkey !== pubkey) {
        return c.json({ ok: false, error: 'Username already claimed' }, 409)
      }
      if (existing.status === 'reserved') {
        return c.json({ ok: false, error: 'Username is reserved' }, 403)
      }
      if (existing.status === 'burned') {
        return c.json({ ok: false, error: 'Username is permanently unavailable' }, 403)
      }
      // If revoked and recyclable, allow claim (continue below)
    }

    // Check if pubkey already has an active username
    const currentUsername = await getUsernameByPubkey(c.env.DB, pubkey)
    if (currentUsername && currentUsername.name !== name) {
      // User is claiming a new username, old one will be auto-revoked
    }

    // Claim the username
    await claimUsername(c.env.DB, name, pubkey, relays)

    // Return success response
    return c.json({
      ok: true,
      name,
      pubkey,
      profile_url: `https://${name}.divine.video/`,
      nip05: {
        main_domain: `${name}@divine.video`,
        underscore_subdomain: `_@${name}.divine.video`,
        host_style: `@${name}.divine.video`
      }
    })

  } catch (error) {
    if (error instanceof Error && error.name === 'Nip98Error') {
      return c.json({ ok: false, error: error.message }, 401)
    }
    console.error('Claim error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default username
```

**Step 2: Install bech32 library**

```bash
npm install @scure/base
```

**Step 3: Wire up route in main app**

Modify `src/index.ts`:

```typescript
import { Hono } from 'hono'
import username from './routes/username'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

export default app
```

**Step 4: Test locally**

```bash
npx wrangler dev
```

Try making a request (will fail auth without valid NIP-98, but should route correctly).

**Step 5: Commit**

```bash
git add src/routes/username.ts src/index.ts package.json package-lock.json
git commit -m "feat: implement username claim endpoint

- Add POST /api/username/claim with NIP-98 auth
- Validate username format and check reserved words
- Handle relay hints (up to 50 relays)
- Auto-revoke old username when claiming new one
- Return profile URL and NIP-05 identifiers

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: NIP-05 Endpoints

**Files:**
- Create: `src/routes/nip05.ts`
- Modify: `src/index.ts`

**Step 1: Create NIP-05 routes**

Create `src/routes/nip05.ts`:

```typescript
// ABOUTME: NIP-05 identity verification endpoints
// ABOUTME: Serves .well-known/nostr.json for root and subdomains

import { Hono } from 'hono'
import { getUsernameByName, getAllActiveUsernames } from '../db/queries'

type Bindings = {
  DB: D1Database
}

const nip05 = new Hono<{ Bindings: Bindings }>()

// Extract subdomain from hostname
function getSubdomain(hostname: string): string | null {
  const parts = hostname.split('.')
  if (parts.length >= 3 && parts[parts.length - 2] === 'divine' && parts[parts.length - 1] === 'video') {
    return parts[0]
  }
  return null
}

nip05.get('/.well-known/nostr.json', async (c) => {
  try {
    const hostname = new URL(c.req.url).hostname
    const subdomain = getSubdomain(hostname)

    if (subdomain) {
      // Subdomain NIP-05: return single user with "_" name
      const username = await getUsernameByName(c.env.DB, subdomain)

      if (!username || username.status !== 'active' || !username.pubkey) {
        return c.notFound()
      }

      const response: any = {
        names: {
          '_': username.pubkey
        }
      }

      // Add relays if present
      if (username.relays) {
        try {
          const relays = JSON.parse(username.relays)
          response.relays = {
            [username.pubkey]: relays
          }
        } catch {
          // Ignore invalid JSON
        }
      }

      return c.json(response, 200, {
        'Cache-Control': 'public, max-age=60'
      })

    } else {
      // Root domain NIP-05: return all active users
      const usernames = await getAllActiveUsernames(c.env.DB)

      const names: Record<string, string> = {}
      const relays: Record<string, string[]> = {}

      for (const username of usernames) {
        if (username.pubkey) {
          names[username.name] = username.pubkey

          if (username.relays) {
            try {
              const relayList = JSON.parse(username.relays)
              relays[username.pubkey] = relayList
            } catch {
              // Ignore invalid JSON
            }
          }
        }
      }

      const response: any = { names }
      if (Object.keys(relays).length > 0) {
        response.relays = relays
      }

      return c.json(response, 200, {
        'Cache-Control': 'public, max-age=60'
      })
    }

  } catch (error) {
    console.error('NIP-05 error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default nip05
```

**Step 2: Wire up route in main app**

Modify `src/index.ts`:

```typescript
import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

// NIP-05
app.route('', nip05)

export default app
```

**Step 3: Test locally**

```bash
npx wrangler dev
```

Visit `http://localhost:8787/.well-known/nostr.json` - should return empty names object.

**Step 4: Commit**

```bash
git add src/routes/nip05.ts src/index.ts
git commit -m "feat: implement NIP-05 endpoints

- Add /.well-known/nostr.json for root and subdomains
- Subdomain returns single user with underscore name
- Root domain returns all active users
- Include relay hints in responses
- Cache responses for 60 seconds

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Subdomain Profile Routing

**Files:**
- Create: `src/routes/subdomain.ts`
- Modify: `src/index.ts`

**Step 1: Create subdomain router**

Create `src/routes/subdomain.ts`:

```typescript
// ABOUTME: Subdomain profile routing middleware
// ABOUTME: Proxies username.divine.video to main app's profile page

import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'

type Bindings = {
  DB: D1Database
}

const subdomain = new Hono<{ Bindings: Bindings }>()

function getSubdomain(hostname: string): string | null {
  const parts = hostname.split('.')
  if (parts.length >= 3 && parts[parts.length - 2] === 'divine' && parts[parts.length - 1] === 'video') {
    return parts[0]
  }
  return null
}

function hexToNpub(hex: string): string {
  // Import bech32 encoding (we already have @scure/base)
  const { bech32 } = require('@scure/base')
  const data = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    data[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  const words = bech32.toWords(data)
  return bech32.encode('npub', words)
}

subdomain.get('/', async (c) => {
  const hostname = new URL(c.req.url).hostname
  const subdomainName = getSubdomain(hostname)

  if (!subdomainName) {
    // Not a subdomain, pass through
    return c.notFound()
  }

  try {
    // Look up username
    const username = await getUsernameByName(c.env.DB, subdomainName)

    if (!username || username.status !== 'active' || !username.pubkey) {
      return c.html(`
        <html>
          <head><title>User Not Found</title></head>
          <body>
            <h1>Username @${subdomainName}.divine.video not found</h1>
            <p>This username is not currently active.</p>
          </body>
        </html>
      `, 404)
    }

    // Convert pubkey to npub
    const npub = hexToNpub(username.pubkey)

    // Proxy to main app
    const mainAppUrl = `https://divine.video/profile/${npub}`
    const response = await fetch(mainAppUrl)

    // Return the response
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    })

  } catch (error) {
    console.error('Subdomain routing error:', error)
    return c.html('<h1>Error loading profile</h1>', 500)
  }
})

export default subdomain
```

**Step 2: Wire up subdomain routing**

Modify `src/index.ts`:

```typescript
import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import subdomain from './routes/subdomain'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// Subdomain profile routing (must be first to catch subdomains)
app.route('', subdomain)

app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

// NIP-05
app.route('', nip05)

export default app
```

**Step 3: Commit**

```bash
git add src/routes/subdomain.ts src/index.ts
git commit -m "feat: implement subdomain profile routing

- Add subdomain detection and lookup
- Proxy username.divine.video to main app profile
- Convert hex pubkey to npub format
- Return 404 for inactive/missing usernames

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Admin Endpoints

**Files:**
- Create: `src/routes/admin.ts`
- Modify: `src/index.ts`

**Step 1: Create admin routes**

Create `src/routes/admin.ts`:

```typescript
// ABOUTME: Admin endpoints for username management
// ABOUTME: Protected by Cloudflare Access, handles reserve/revoke/burn/assign

import { Hono } from 'hono'
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName } from '../db/queries'
import { validateUsername } from '../utils/validation'

type Bindings = {
  DB: D1Database
}

const admin = new Hono<{ Bindings: Bindings }>()

// Note: These routes are protected by Cloudflare Access at the edge
// No additional auth needed in worker code

admin.post('/reserve', async (c) => {
  try {
    const body = await c.req.json<{ name: string; reason?: string }>()
    const { name, reason = 'Reserved by admin' } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    validateUsername(name)

    await reserveUsername(c.env.DB, name, reason)

    return c.json({ ok: true, name, status: 'reserved' })
  } catch (error) {
    console.error('Reserve error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/revoke', async (c) => {
  try {
    const body = await c.req.json<{ name: string; burn?: boolean }>()
    const { name, burn = false } = body

    if (!name) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    const existing = await getUsernameByName(c.env.DB, name)
    if (!existing) {
      return c.json({ ok: false, error: 'Username not found' }, 404)
    }

    await revokeUsername(c.env.DB, name, burn)

    return c.json({
      ok: true,
      name,
      status: burn ? 'burned' : 'revoked',
      recyclable: !burn
    })
  } catch (error) {
    console.error('Revoke error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

admin.post('/assign', async (c) => {
  try {
    const body = await c.req.json<{ name: string; pubkey: string }>()
    const { name, pubkey } = body

    if (!name || !pubkey) {
      return c.json({ ok: false, error: 'Name and pubkey are required' }, 400)
    }

    validateUsername(name)

    if (pubkey.length !== 64 || !/^[0-9a-f]+$/.test(pubkey)) {
      return c.json({ ok: false, error: 'Invalid pubkey format' }, 400)
    }

    await assignUsername(c.env.DB, name, pubkey)

    return c.json({ ok: true, name, pubkey, status: 'active' })
  } catch (error) {
    console.error('Assign error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})

export default admin
```

**Step 2: Wire up admin routes**

Modify `src/index.ts`:

```typescript
import { Hono } from 'hono'
import username from './routes/username'
import nip05 from './routes/nip05'
import subdomain from './routes/subdomain'
import admin from './routes/admin'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// Subdomain profile routing (must be first to catch subdomains)
app.route('', subdomain)

app.get('/', (c) => {
  return c.json({
    service: 'divine-name-server',
    version: '0.1.0'
  })
})

// Username API
app.route('/api/username', username)

// Admin API (protected by Cloudflare Access)
app.route('/api/admin/username', admin)

// NIP-05
app.route('', nip05)

export default app
```

**Step 3: Commit**

```bash
git add src/routes/admin.ts src/index.ts
git commit -m "feat: implement admin endpoints

- Add POST /api/admin/username/reserve
- Add POST /api/admin/username/revoke (with burn option)
- Add POST /api/admin/username/assign
- Protected by Cloudflare Access at edge

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Deploy to Production

**Files:**
- Modify: `wrangler.toml`
- Create: `.dev.vars` (local only, not committed)

**Step 1: Update wrangler.toml with actual database ID**

Rabble should provide the actual D1 database ID. Update `wrangler.toml`:

```toml
name = "divine-name-server"
main = "src/index.ts"
compatibility_date = "2024-11-15"

[[d1_databases]]
binding = "DB"
database_name = "divine-name-server-db"
database_id = "<ACTUAL-DATABASE-ID-HERE>"
```

**Step 2: Apply migrations to remote database**

```bash
npx wrangler d1 migrations apply divine-name-server-db --remote
```

Expected: Migrations applied successfully.

**Step 3: Deploy worker**

```bash
npx wrangler deploy
```

Expected: Worker deployed to `divine-name-server.<account>.workers.dev`

**Step 4: Test deployed worker**

```bash
curl https://divine-name-server.<account>.workers.dev/
```

Expected: JSON response with service info.

**Step 5: Test NIP-05 endpoint**

```bash
curl https://divine-name-server.<account>.workers.dev/.well-known/nostr.json
```

Expected: Empty names object `{"names":{}}`

**Step 6: Commit wrangler config**

```bash
git add wrangler.toml
git commit -m "chore: update wrangler config with production database

- Add actual D1 database ID
- Ready for production deployment

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Documentation

**Files:**
- Create: `README.md`

**Step 1: Create README**

Create `README.md`:

```markdown
# Divine Name Server

Cloudflare Worker that enables username-based Nostr identities at Divine.Video.

## Features

- **Username Claiming**: Users claim usernames via NIP-98 signed HTTP requests
- **Subdomain Profiles**: `https://alice.divine.video/` serves user profiles
- **NIP-05 Verification**: Nostr identity verification at `/.well-known/nostr.json`
- **Admin Management**: Reserve, revoke, burn, or assign usernames
- **Relay Hints**: Store and serve relay hints for better discoverability (up to 50 relays)

## Tech Stack

- **Hono**: Lightweight web framework for Cloudflare Workers
- **D1**: Cloudflare's SQLite database
- **NIP-98**: HTTP authentication via Nostr event signatures
- **TypeScript**: Type-safe implementation

## Development

### Setup

```bash
npm install
```

### Local Development

```bash
# Apply migrations locally
npx wrangler d1 migrations apply divine-name-server-db --local

# Start dev server
npx wrangler dev
```

### Testing

```bash
npm test
```

### Deployment

```bash
# Apply migrations to remote
npx wrangler d1 migrations apply divine-name-server-db --remote

# Deploy worker
npx wrangler deploy
```

## API Endpoints

### POST /api/username/claim

Claim a username with NIP-98 authentication.

**Headers:**
- `Authorization: Nostr <base64-event>`

**Body:**
```json
{
  "name": "alice",
  "relays": ["wss://relay.damus.io", "wss://nos.lol"]
}
```

**Response:**
```json
{
  "ok": true,
  "name": "alice",
  "pubkey": "<hex>",
  "profile_url": "https://alice.divine.video/",
  "nip05": {
    "main_domain": "alice@divine.video",
    "underscore_subdomain": "_@alice.divine.video",
    "host_style": "@alice.divine.video"
  }
}
```

### GET /.well-known/nostr.json

NIP-05 identity verification.

**Subdomain** (`alice.divine.video`):
```json
{
  "names": {
    "_": "<pubkey>"
  },
  "relays": {
    "<pubkey>": ["wss://relay.damus.io"]
  }
}
```

**Root domain** (`divine.video`):
```json
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
```

### Admin Endpoints (Protected by Cloudflare Access)

**POST /api/admin/username/reserve**
```json
{
  "name": "brandname",
  "reason": "Brand protection"
}
```

**POST /api/admin/username/revoke**
```json
{
  "name": "badname",
  "burn": true
}
```

**POST /api/admin/username/assign**
```json
{
  "name": "famousviner",
  "pubkey": "<hex>"
}
```

## Database Schema

See `migrations/0001_initial_schema.sql` for complete schema.

**Tables:**
- `usernames` - Username to pubkey mappings with status
- `reserved_words` - Protected system routes and brand names

**Status Values:**
- `active` - Currently claimed
- `reserved` - Admin-reserved
- `revoked` - Freed up, reclaimable
- `burned` - Permanently unavailable

## Username Rules

- 3-20 characters
- Lowercase alphanumeric only
- Cannot use reserved words
- One active username per pubkey
- Up to 50 relay hints per username

## Relay Validation

- Optional field
- Must be `wss://` URLs
- Max 50 relays per user
- Max 200 characters per URL

## Architecture

See `docs/plans/2025-11-15-divine-name-server-design.md` for complete technical design.

## License

MIT
```

**Step 2: Commit README**

```bash
git add README.md
git commit -m "docs: add comprehensive README

- Document API endpoints and usage
- Add development setup instructions
- Explain username rules and validation
- Include database schema overview

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Post-Implementation Tasks

After all tasks complete:

1. **Configure Cloudflare Routes** in dashboard to route traffic to worker
2. **Set up Cloudflare Access** for admin endpoints
3. **Test end-to-end** with real Nostr client and NIP-98 signatures
4. **Monitor logs** in Cloudflare dashboard for errors
5. **Verify NIP-05** works in Damus, Amethyst, or other Nostr apps

## Success Criteria

- [ ] Worker deployed and accessible
- [ ] Database migrations applied
- [ ] Username claiming works with valid NIP-98 signature
- [ ] Subdomain profiles load successfully
- [ ] NIP-05 endpoints return correct data
- [ ] Admin endpoints protected and functional
- [ ] All tests passing
- [ ] Documentation complete

---

**Total estimated time:** 3-4 hours for experienced developer with no context.
