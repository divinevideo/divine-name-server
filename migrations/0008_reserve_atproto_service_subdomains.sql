-- ABOUTME: Reserve service subdomains needed for ATProto and edge routing

INSERT OR IGNORE INTO reserved_words (word, category, reason, created_at) VALUES
('names', 'system', 'Name server host', unixepoch()),
('www', 'system', 'WWW subdomain', unixepoch()),
('login', 'system', 'Keycast login host', unixepoch()),
('pds', 'system', 'ATProto PDS host', unixepoch()),
('feed', 'system', 'ATProto feed generator host', unixepoch()),
('labeler', 'system', 'ATProto labeler host', unixepoch()),
('relay', 'system', 'Nostr relay host', unixepoch()),
('media', 'system', 'Media delivery host', unixepoch());
