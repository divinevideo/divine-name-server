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
