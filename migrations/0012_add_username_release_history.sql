-- ABOUTME: Append-only breadcrumb of deletion-driven name releases.
-- No pubkey: a completed deletion removes the identity. This records only that a
-- handle was released by deletion, so support can see that a reissued handle
-- previously belonged to a since-deleted account.
CREATE TABLE IF NOT EXISTS username_release_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_canonical TEXT NOT NULL,
  released_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_release_history_canonical
  ON username_release_history (username_canonical);
