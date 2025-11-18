-- ABOUTME: Add email field to usernames table for admin search
-- ABOUTME: Create index for efficient LIKE queries on email

-- Add email column (optional field)
ALTER TABLE usernames ADD COLUMN email TEXT;

-- Create index for email lookups
CREATE INDEX IF NOT EXISTS idx_usernames_email ON usernames(email);
