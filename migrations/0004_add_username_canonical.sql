-- ABOUTME: Add username_display and username_canonical fields for case-insensitive matching
-- ABOUTME: Migrates existing data and enforces uniqueness on canonical form

-- Add new columns (nullable initially for migration)
ALTER TABLE usernames ADD COLUMN username_display TEXT;
ALTER TABLE usernames ADD COLUMN username_canonical TEXT;

-- Migrate existing data: use name as both display and canonical (lowercase)
UPDATE usernames SET username_display = name, username_canonical = LOWER(name) WHERE username_canonical IS NULL;

-- Create unique index on username_canonical (enforces uniqueness going forward)
CREATE UNIQUE INDEX IF NOT EXISTS idx_usernames_canonical ON usernames(username_canonical);

-- Note: The original UNIQUE constraint on the 'name' column remains for backward compatibility,
-- but all new lookups and inserts should use username_canonical for case-insensitive matching.

