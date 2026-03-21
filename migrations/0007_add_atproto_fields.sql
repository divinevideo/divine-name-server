-- Add ATProto identity fields for handle resolution
-- atproto_did: the user's did:plc identifier (set by control plane)
-- atproto_state: lifecycle state for ATProto handle resolution
ALTER TABLE usernames ADD COLUMN atproto_did TEXT DEFAULT NULL;
ALTER TABLE usernames ADD COLUMN atproto_state TEXT DEFAULT NULL;
