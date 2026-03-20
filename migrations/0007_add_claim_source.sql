-- Migration: Add claim_source and created_by columns for username provenance tracking.
--
-- claim_source values:
--   'self-service'        — User claimed via NIP-98 signature (POST /api/username/claim)
--   'admin'               — Admin reserved or assigned a single name
--   'bulk-upload'         — Admin reserved or assigned in bulk
--   'vine-import'         — Imported from Vine archive (scripts/import-vine-users.ts)
--   'public-reservation'  — Reserved via email + Cashu/invite payment (POST /api/username/reserve)
--   'unknown'             — Pre-existing record (migration default)
--
-- created_by: CF Access email of the admin who performed the action. NULL for non-admin paths.
-- Enum validation enforced in application code (ClaimSource type), not DB constraints.

ALTER TABLE usernames ADD COLUMN claim_source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE usernames ADD COLUMN created_by TEXT DEFAULT NULL;
