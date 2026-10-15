CREATE TABLE IF NOT EXISTS experiments(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario VARCHAR(64) NOT NULL,
  seed INTEGER NOT NULL CHECK (seed >= 0),
  controller VARCHAR(32) NOT NULL CHECK (controller IN ('comparison','baseline','swarm')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_experiments_created_at ON experiments (created_at DESC);
