-- Migration 008: tracks every ingest script invocation, so the UI can show "data updated
-- <time>" and warn if the last run failed or is stale, without having to infer that from
-- solicitations rows alone.
CREATE TABLE ingest_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  -- Every source_date this run attempted (one run can cover several dates -- the default
  -- rolling-window mode -- or just one, for an explicit single-date run).
  dates_pulled text[] NOT NULL,
  rows_inserted integer NOT NULL,
  rows_updated integer NOT NULL,
  status text NOT NULL, -- 'complete' | 'partial' | 'failed' (mirrors IngestResult.status, plus 'failed' for a thrown error)
  error text -- NULL unless status = 'failed'
);

-- The UI's freshness check always wants "the most recent run" -- this is that lookup's index.
CREATE INDEX ingest_runs_started_at_idx ON ingest_runs (started_at DESC);
