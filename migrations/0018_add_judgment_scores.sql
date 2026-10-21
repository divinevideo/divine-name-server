-- Retain the decision score for newly judged verdicts. Existing verdicts remain
-- valid with NULL scores; applying this adds no rows and changes no verdict.
ALTER TABLE block_verdicts ADD COLUMN score REAL
  CHECK (score IS NULL OR (score >= 0 AND score <= 1));

-- Cover the admin aggregate read without returning individual names.
CREATE INDEX IF NOT EXISTS idx_block_verdicts_score_distribution
  ON block_verdicts (blocklist_version, threshold, verdict, score);
