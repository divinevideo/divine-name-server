-- ABOUTME: Adds public name reservation with email confirmation and subscription support
-- ABOUTME: New reservation_tokens table and additional columns on usernames

-- Add reservation-related columns to usernames table
ALTER TABLE usernames ADD COLUMN reservation_email TEXT;
ALTER TABLE usernames ADD COLUMN confirmation_token TEXT;
ALTER TABLE usernames ADD COLUMN reservation_expires_at INTEGER;
ALTER TABLE usernames ADD COLUMN subscription_expires_at INTEGER;

-- Unique index on confirmation_token for fast token lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_usernames_confirmation_token
  ON usernames(confirmation_token)
  WHERE confirmation_token IS NOT NULL;

-- Token log for reservation confirmation emails
-- Tracks all reservation attempts for rate limiting and auditing
CREATE TABLE IF NOT EXISTS reservation_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  username_canonical TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  expires_at INTEGER NOT NULL
);

-- Fast email lookups for rate limiting
CREATE INDEX IF NOT EXISTS idx_reservation_tokens_email
  ON reservation_tokens(email);

-- Fast username lookups
CREATE INDEX IF NOT EXISTS idx_reservation_tokens_username
  ON reservation_tokens(username_canonical);
