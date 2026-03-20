Below is a complete, professional-grade PRD + acceptance criteria + task breakdown, written for a modern lean/agile engineering team building Divine.Video’s Username Subdomain + Nostr Identity feature on Cloudflare Workers + D1.

This is the version you can hand directly to your team.

⸻

📘 Product Requirements Document (PRD)

Feature: Usernames as Subdomains + Nostr Identity (@name.divine.video)

Version: 1.0
Owner: Divine.Video Engineering
Status: Draft for Implementation
Scope: Backend (Cloudflare Worker + D1 + DNS + API). Frontend changes tracked separately.

⸻

1. Overview

Divine.Video will allow users to claim a username that becomes:
	•	A subdomain:
https://<username>.divine.video/
	•	A Nostr identity:
@<username>.divine.video
(displayed form, compatible with clients via _@name.divine.video + name@divine.video NIP-05 backends)

This provides:
	•	A clean, Bluesky-style identity for Nostr users
	•	A public profile URL rooted at their username
	•	NIP-05 verification from both main domain and subdomain
	•	Admin ability to reserve/revoke/burn usernames
	•	Storage in D1
	•	All requests authenticated via NIP-98 signed HTTP

This feature introduces a minimal but durable identity layer for Divine.Video without introducing global user accounts.

⸻

2. Problem Statement

Users currently only have an npub-based profile URL:

https://divine.video/profile/<npub>

Users want a clean, human-readable handle similar to:

@alice.divine.video

Nostr clients support NIP-05, but the “clean form” (@name.divine.video) is not supported directly — instead they require _@name.divine.video.
We hide this complexity while providing full compatibility.

There is currently no database of usernames, no way to verify identity under a Divine.Video domain, and no mechanism to safely claim or manage user-facing names.

⸻

3. Goals

Primary Goals
	1.	Allow users to claim a username using their Nostr key via NIP-98 signed HTTP.
	2.	Serve a profile page at https://<username>.divine.video/.
	3.	Support NIP-05 identity resolution for:
	•	name@divine.video
	•	_@name.divine.video
	•	Display-only @name.divine.video
	4.	Maintain a secure, scalable registry in D1.
	5.	Allow admins to reserve, revoke, burn, or reassign usernames.

Secondary Goals
	•	Provide clean API responses for mobile/web client integrations.
	•	Avoid introducing a centralized “account” system — only “username ↔ key” mapping.
	•	Support future key rotation.

⸻

4. Non-Goals
	•	Full profile rendering (handled by frontend React app).
	•	User authentication flows (handled by Nostr keys + NIP-98).
	•	Cross-domain cookie auth (not needed).
	•	Web UI for claiming names (initially API-only).
	•	Bulk NIP-05 enumeration at scale beyond MVP.

⸻

5. User Stories

User Claiming a Name
	•	As a user,
I want to claim name.divine.video by proving I own the pubkey,
so that I have a human-readable identity.

User Viewing a Profile
	•	As a viewer,
I can visit https://name.divine.video/ and see the user’s profile.

Admin Operations
	•	As an admin,
I can reserve names (brand protection & famous viners).
	•	As an admin,
I can revoke or burn offensive or abused names.
	•	As an admin,
I can reassign a name to a new pubkey if needed.

⸻

6. Functional Requirements

6.1 Username Claiming

6.1.1 POST /api/username/claim
	•	Requires NIP-98 signed HTTP request.
	•	Body: { "name": "username" }
	•	Worker:
	•	Extract pubkey from signature.
	•	Validate name formatting rules.
	•	Ensure pubkey does not already own a name.
	•	Check D1 for existing row.
	•	Insert or update as appropriate.
	•	Response:

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



⸻

6.2 Username Status Management (Admin Only)

6.2.1 POST /api/admin/username/reserve
	•	Body: { "name": "brandname", "reason": "...", "burn": false }
	•	Marks name as reserved.
	•	pubkey = NULL, status = 'reserved'.

6.2.2 POST /api/admin/username/revoke
	•	Body: { "name": "offensivename", "burn": true|false }
	•	Sets status to revoked or burned.

6.2.3 POST /api/admin/username/assign
	•	Body: { "name": "famousviner", "pubkey": "<hex>" }
	•	Directly assigns.

Admin endpoints are protected via CF Access or shared-secret header.

⸻

6.3 Profile Routing

6.3.1 GET https://.divine.video/
	•	Lookup username in D1.
	•	If active → redirect to https://divine.video/profile/<pubkey>
(MVP: 302 redirect)
	•	If revoked/burned/reserved/unclaimed → 404 or custom landing page.

⸻

6.4 NIP-05 Resolution

6.4.1 Subdomain NIP-05

GET https://<username>.divine.video/.well-known/nostr.json

Response (if active):

{
  "names": {
    "_": "<pubkey>"
  }
}

404 otherwise.

6.4.2 Root Domain NIP-05

GET https://divine.video/.well-known/nostr.json

Response:

{
  "names": {
    "alice": "<pubkey>",
    "bob": "<pubkey>"
  }
}

(Only active names.)

⸻

7. Technical Requirements

7.1 D1 Schema

CREATE TABLE IF NOT EXISTS usernames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pubkey TEXT,
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


⸻

7.1.1 Username Provenance

Each username record tracks how it was created via `claim_source` and optionally who created it via `created_by`.

| claim_source | Meaning | created_by |
|-------------|---------|------------|
| `self-service` | User claimed via NIP-98 signature | null (pubkey is the identity) |
| `admin` | Admin reserved or assigned a single name | CF Access email of the admin |
| `bulk-upload` | Admin reserved or assigned in bulk | CF Access email of the admin |
| `vine-import` | Imported from Vine archive | null (script-level operation) |
| `public-reservation` | Reserved via email + Cashu/invite payment | null (email in reservation_email) |
| `unknown` | Pre-existing record (before migration 0007) | null |

Notes:
- `claim_source` reflects current provenance, not a changelog. If a name is reassigned, only the most recent source is recorded.
- Status-changing operations (revoke, burn, expire) do not alter `claim_source` or `created_by`.
- `created_by` only contains internal team emails (CF Access), never end-user PII.

⸻

7.2 Cloudflare Worker Responsibilities

Required:
	•	Wildcard subdomain routing.
	•	NIP-98 signature verification.
	•	SQL queries to D1.
	•	Cache small NIP-05 responses via cache-control.

Out of scope:
	•	No persistent sessions.
	•	No cookies.
	•	No OAuth or NIP-07.

⸻

8. Constraints
	•	NIP-98 verification must occur on every claim/update request.
	•	Subdomain routing must be cheap → edge-evaluated.
	•	NIP-05 must remain spec-compliant for clients that rely on name@domain and _@hostname.
	•	Future key rotation must not require redesign of table.

⸻

9. Security Considerations
	•	All claims require cryptographic proof of key ownership via NIP-98.
	•	Admin endpoints protected by CF Access or shared-secret header.
	•	Offensive / trademark names can be burned permanently.
	•	No user can hijack a username owned by another pubkey.
	•	No implicit trust of unsigned HTTP.

⸻

10. Open Questions

(These can be resolved later; not blocking MVP.)
	•	Should we allow multiple reserved reasons per name?
	•	Bulk-import list of “famous viners”?
	•	Time-based reassign cooldown?

⸻

11. Success Metrics
	•	Time-to-claim is <150ms P99.
	•	Subdomain profiles load as fast as profile/<npub>.
	•	95% of users switch to @name.divine.video within 30 days.
	•	NIP-05 verification succeeds in major Nostr apps (Damus, Amethyst, Nos, Coracle).

⸻

⸻

✔ Task Breakdown (Engineering Work Plan)

Phase 1 — Foundations

Task 1: Create D1 Schema
	•	Create table usernames.
	•	Create unique active-index.
Acceptance Criteria:
	•	Running migration creates correct DB structure.
	•	Index prevents multiple active names per pubkey.

Task 2: Wildcard Routing in Worker
	•	Handle root vs subdomain logic.
	•	Pass through all unrelated paths to existing app.
Acceptance Criteria:
	•	Requests to alice.divine.video reach Worker.
	•	Root domain remains unchanged.

⸻

Phase 2 — Claim Flow

Task 3: Implement NIP-98 Verification
	•	Parse headers.
	•	Extract pubkey.
	•	Reject if invalid.
Acceptance Criteria:
	•	Valid signatures return pubkey.
	•	Invalid/missing signatures → 401.

Task 4: Implement /api/username/claim
	•	Validate name.
	•	Check constraints.
	•	Insert/update row.
Acceptance Criteria:
	•	Pubkey with no name can claim a new one.
	•	Duplicate names get 409.
	•	Reserved/burned names get 403.
	•	Recyclable revoked names can be reclaimed.

⸻

Phase 3 — Profile Routing

Task 5: Implement Subdomain Profile Redirect
	•	GET https://name.divine.video/ → redirect to canonical npub profile.
Acceptance Criteria:
	•	Active names redirect correctly.
	•	Nonexistent names return 404.
	•	Revoked/burned names return 404.

⸻

Phase 4 — NIP-05 Endpoints

Task 6: Implement //.well-known/nostr.json

Acceptance Criteria:
	•	Returns _ → pubkey.
	•	404 for inactive names.

Task 7: Implement /divine.video/.well-known/nostr.json

Acceptance Criteria:
	•	Returns all active mappings.
	•	Sorted or unsorted is fine.
	•	Works with >1,000 entries.

⸻

Phase 5 — Admin API

Task 8: Reserve Name

Acceptance Criteria:
	•	Name becomes reserved.
	•	Cannot be claimed by users.

Task 9: Revoke/Burn Name

Acceptance Criteria:
	•	Revoked → reclaimable.
	•	Burned → permanently unusable.

Task 10: Assign Name to Pubkey

Acceptance Criteria:
	•	Admin can directly assign.
	•	Overwrites pubkey only when explicitly forced.

⸻

Phase 6 — Hardening

Task 11: Add Caching Layer for NIP-05

Acceptance Criteria:
	•	nostr.json responses include cache-control: public, max-age=60.

Task 12: Add Monitoring / Logging

Acceptance Criteria:
	•	Log name claims, errors.
	•	Cloudflare analytics show routing health.

⸻

⸻

✔ Acceptance Criteria (High Fidelity)

AC-1: Claiming a username
	•	Given a valid NIP-98 request
	•	When calling /api/username/claim
	•	And name is valid & unclaimed
	•	Then the system stores {name, pubkey, status='active'}
	•	And returns profile_url + all NIP-05 formats.

AC-2: Cannot claim a taken name
	•	Given name is already active
	•	Then second claims return 409 name-taken.

AC-3: Cannot claim reserved/burned names
	•	When name is reserved or burned
	•	Return 403.

AC-4: Subdomain profile routing
	•	GET https://name.divine.video/ redirects to canonical npub profile.
	•	Inactive names → 404.

AC-5: Subdomain NIP-05
	•	/.well-known/nostr.json returns a single _ field mapped to pubkey.

AC-6: Root-domain NIP-05
	•	/divine.video/.well-known/nostr.json contains all active mappings.

AC-7: Admin operations work
	•	Reserve blocks claims.
	•	Revoke frees name.
	•	Burn prevents all future use.
	•	Assign maps pubkey to name.

AC-8: Security
	•	Only NIP-98-signed requests can claim names.
	•	Only authenticated admins can modify name states.
	•	No race allows two pubkeys to claim the same name.

⸻

If you want, next I can provide:

✅ API documentation
✅ Worker code skeleton
✅ Admin tooling commands
✅ Database migration script
✅ OpenAPI/Swagger spec
Just tell me what order you want them.
