-- Index for delta sync query (getUsernamesUpdatedSince)
CREATE INDEX IF NOT EXISTS idx_usernames_updated_at ON usernames (updated_at);
