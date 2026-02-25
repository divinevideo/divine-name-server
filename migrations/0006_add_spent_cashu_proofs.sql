-- ABOUTME: Adds spent_cashu_proofs table for tracking redeemed Cashu token proofs
-- ABOUTME: Prevents replay attacks where the same proof is used for multiple reservations

CREATE TABLE IF NOT EXISTS spent_cashu_proofs (
  proof_secret TEXT PRIMARY KEY,
  cashu_token_hash TEXT NOT NULL,
  username_canonical TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Fast lookups by token hash to find all proofs from a given token
CREATE INDEX IF NOT EXISTS idx_spent_cashu_proofs_token_hash
  ON spent_cashu_proofs(cashu_token_hash);
