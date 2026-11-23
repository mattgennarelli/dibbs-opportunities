-- Migration 002: two parser-bug fixes discovered 2026-11-23 (full ingest of 11-20-2026)
-- need matching schema changes.

-- status used to always be a string, defaulting to '' when the cell's markup didn't match
-- (e.g. a nested <strong> around "Removed"). The parser fix (lib/parseRfqGrid.ts) now
-- returns NULL instead of '' for that case, so the column has to allow NULL to store it
-- truthfully instead of coercing back to '' at the DB boundary.
ALTER TABLE solicitations ALTER COLUMN status DROP NOT NULL;

-- New column: true when the solicitation-number cell's anchor includes a "--»Attachments"
-- marker. The parser used to silently drop these rows entirely (the marker's own "<br>"
-- broke the old regex) -- this column is what "don't drop the info" becomes once the row
-- parses correctly. Defaulted to false (not NULL) because its absence is itself meaningful
-- information ("no attachments marker was present"), not a parse failure.
ALTER TABLE solicitations ADD COLUMN has_attachments boolean NOT NULL DEFAULT false;
