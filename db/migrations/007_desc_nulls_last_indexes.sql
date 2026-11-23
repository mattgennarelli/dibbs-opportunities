-- Migration 007: explicit DESC NULLS LAST indexes for every nullable browse-sort column.
--
-- A plain `(col, id)` index (migrations 001/004/006) is stored ASC with NULLs LAST by
-- Postgres's default. Scanning that index BACKWARD gives DESC order, but backward also
-- flips the NULL placement: NULLS LAST becomes NULLS FIRST when read in reverse. Since this
-- app always wants NULLS LAST regardless of direction (a missing quantity/issued
-- date/FSC/NSN should stay at the end whether sorted ascending or descending -- see
-- lib/apiQuery.ts's browseOrderBy), a backward scan of the ASC index cannot serve
-- `ORDER BY col DESC NULLS LAST` -- it would need to be a forward scan of an index that was
-- itself built DESC NULLS LAST.
--
-- return_by_date needs no DESC-specific index: open_solicitations' own WHERE already
-- excludes every NULL return_by_date row (see db/migrations/001_init.sql), so there's no
-- NULL-placement question for that column in either direction -- the existing ASC index,
-- read backward, already serves DESC correctly.
CREATE INDEX solicitations_quantity_desc_id_idx ON solicitations (quantity DESC NULLS LAST, id DESC);
CREATE INDEX solicitations_issued_date_desc_id_idx ON solicitations (issued_date DESC NULLS LAST, id DESC);
CREATE INDEX solicitations_fsc_desc_id_idx ON solicitations (fsc DESC NULLS LAST, id DESC);
CREATE INDEX solicitations_nsn_digits_desc_id_idx ON solicitations (nsn_digits DESC NULLS LAST, id DESC);
