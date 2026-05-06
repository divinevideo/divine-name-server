-- ABOUTME: Track who last edited admin notes and when for accountability.
-- ABOUTME: Keeps lightweight audit metadata on the usernames row without a separate history table.

ALTER TABLE usernames ADD COLUMN admin_notes_updated_by TEXT DEFAULT NULL;
ALTER TABLE usernames ADD COLUMN admin_notes_updated_at INTEGER DEFAULT NULL;
