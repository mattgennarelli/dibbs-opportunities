-- Migration 005: refreshes open_solicitations to expose columns added after it was first
-- created.
--
-- open_solicitations (migration 001) was defined as `SELECT * FROM solicitations WHERE
-- ...`. Postgres freezes a SELECT * view's column list at CREATE VIEW time -- a later
-- `ALTER TABLE solicitations ADD COLUMN ...` (migration 002's status/has_attachments
-- changes) does NOT propagate to the view automatically. Every API route in this app
-- queries the view, not the base table, so it silently couldn't see has_attachments until
-- this re-issue. CREATE OR REPLACE VIEW is safe here specifically because we're only ever
-- adding trailing columns via SELECT * -- it would be rejected if this dropped or reordered
-- any existing output column.
CREATE OR REPLACE VIEW open_solicitations AS
SELECT *
FROM solicitations
WHERE return_by_date >= (now() AT TIME ZONE 'America/New_York')::date
  AND status = 'Open';
