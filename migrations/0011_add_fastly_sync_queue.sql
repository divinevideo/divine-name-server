CREATE TABLE IF NOT EXISTS fastly_sync_queue (
  username_canonical TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('sync', 'delete')),
  payload_json TEXT,
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_fastly_sync_queue_updated_at ON fastly_sync_queue (updated_at);
