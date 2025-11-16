-- ABOUTME: Seeds reserved words to protect system routes and brand names

INSERT OR IGNORE INTO reserved_words (word, category, reason, created_at) VALUES
-- System routes
('api', 'system', 'API endpoint root', unixepoch()),
('www', 'system', 'WWW subdomain', unixepoch()),
('admin', 'system', 'Admin interface', unixepoch()),
('support', 'system', 'Support pages', unixepoch()),
('help', 'system', 'Help documentation', unixepoch()),
('status', 'system', 'Status page', unixepoch()),
('health', 'system', 'Health check', unixepoch()),
('docs', 'system', 'Documentation', unixepoch()),
('blog', 'system', 'Blog', unixepoch()),

-- Common subdomains
('mail', 'subdomain', 'Email server', unixepoch()),
('email', 'subdomain', 'Email service', unixepoch()),
('ftp', 'subdomain', 'FTP server', unixepoch()),
('smtp', 'subdomain', 'SMTP server', unixepoch()),
('imap', 'subdomain', 'IMAP server', unixepoch()),
('cdn', 'subdomain', 'CDN', unixepoch()),
('static', 'subdomain', 'Static assets', unixepoch()),
('assets', 'subdomain', 'Asset server', unixepoch()),

-- Application routes
('profile', 'app', 'Profile pages', unixepoch()),
('user', 'app', 'User pages', unixepoch()),
('users', 'app', 'Users directory', unixepoch()),
('settings', 'app', 'Settings page', unixepoch()),
('account', 'app', 'Account management', unixepoch()),
('dashboard', 'app', 'Dashboard', unixepoch()),
('upload', 'app', 'Upload endpoint', unixepoch()),
('video', 'app', 'Video pages', unixepoch()),
('videos', 'app', 'Videos directory', unixepoch()),

-- Nostr protocol
('relay', 'protocol', 'Nostr relay', unixepoch()),
('relays', 'protocol', 'Relay directory', unixepoch()),
('nostr', 'protocol', 'Nostr protocol', unixepoch()),
('nip', 'protocol', 'Nostr protocol spec', unixepoch()),
('nips', 'protocol', 'Nostr protocol specs', unixepoch()),
('wellknown', 'protocol', 'Well-known directory', unixepoch()),

-- Brand protection
('divine', 'brand', 'Brand name', unixepoch()),
('divinevideo', 'brand', 'Brand name variation', unixepoch()),
('divinedevideo', 'brand', 'Common typo', unixepoch());
