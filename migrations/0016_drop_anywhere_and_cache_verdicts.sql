-- Drop the hardcoded anywhere list. Those words stay at token scope.
-- A blocked word glued inside a longer name is judged, not substring-blocked.
-- match_plain is the moderator-approved exception: a proposed word, once
-- approved, is a plain substring match and does not need another call.

UPDATE reserved_words SET match_scope = 'token' WHERE match_scope = 'anywhere';

ALTER TABLE reserved_words ADD COLUMN match_plain INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS blocklist_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

INSERT OR IGNORE INTO blocklist_meta (id, version) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS block_verdicts (
  canonical TEXT NOT NULL,
  blocklist_version INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('blocked', 'clear')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (canonical, blocklist_version)
);

CREATE TABLE IF NOT EXISTS blocklist_proposals (
  word TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);

CREATE TABLE IF NOT EXISTS jev_call_buckets (
  minute_bucket INTEGER PRIMARY KEY,
  calls INTEGER NOT NULL
);
