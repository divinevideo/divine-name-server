-- ABOUTME: Adds free-form internal tags for usernames in the admin UI
-- ABOUTME: Supports note/tag search, sorting, and stats without changing public APIs

CREATE TABLE IF NOT EXISTS username_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_id INTEGER NOT NULL,
  tag_display TEXT NOT NULL,
  tag_normalized TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(username_id, tag_normalized),
  FOREIGN KEY (username_id) REFERENCES usernames(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_username_tags_username_id
  ON username_tags(username_id);

CREATE INDEX IF NOT EXISTS idx_username_tags_tag_normalized
  ON username_tags(tag_normalized);
