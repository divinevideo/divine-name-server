-- ABOUTME: Add username_tags junction table for free-form tagging
-- ABOUTME: Tags are lowercase strings attached to username records

CREATE TABLE IF NOT EXISTS username_tags (
  username_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (username_id, tag),
  FOREIGN KEY (username_id) REFERENCES usernames(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_username_tags_tag ON username_tags(tag);
