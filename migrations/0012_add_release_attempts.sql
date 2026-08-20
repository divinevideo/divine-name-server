-- ABOUTME: Adds recoverable username-release attempts and versioned Fastly reconciliation.
-- ABOUTME: Enforces one owned (active or pending-release) username per pubkey.

DROP INDEX IF EXISTS idx_usernames_pubkey_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usernames_pubkey_owned
  ON usernames(LOWER(pubkey))
  WHERE pubkey IS NOT NULL AND status IN ('active', 'pending-release');

CREATE TABLE IF NOT EXISTS username_release_attempts (
  attempt_id TEXT PRIMARY KEY,
  username_canonical TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'cancelled', 'finalized', 'expired-restored')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  finalized_at INTEGER,
  finalized_by TEXT,
  FOREIGN KEY (username_canonical) REFERENCES usernames(username_canonical)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_attempts_pending_pubkey
  ON username_release_attempts(LOWER(pubkey)) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_release_attempts_username
  ON username_release_attempts(username_canonical);
CREATE INDEX IF NOT EXISTS idx_release_attempts_state_expires
  ON username_release_attempts(state, expires_at);

ALTER TABLE fastly_sync_queue ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
