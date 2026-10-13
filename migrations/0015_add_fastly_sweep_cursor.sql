-- Durable progress for the bounded full-table reconciliation sweep.
CREATE TABLE fastly_sweep_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_id INTEGER NOT NULL DEFAULT 0
);
INSERT INTO fastly_sweep_cursor (id, after_id) VALUES (1, 0);
