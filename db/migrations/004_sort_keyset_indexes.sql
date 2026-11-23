-- Migration 004: composite (column, id) indexes for every browse-mode sort key, so keyset
-- pagination stays an index scan at scale instead of degrading to a sort-the-whole-table
-- plan once a single-column index can order by the sort column but not break ties on id.
--
-- (Originally asked for as part of migration 003, but 003 was already applied earlier this
-- session -- migrations are treated as immutable once applied, so this is a new file
-- instead of editing 003 after the fact.)

-- sort=quantity keyset pagination.
CREATE INDEX solicitations_quantity_id_idx ON solicitations (quantity, id);

-- sort=issued keyset pagination.
CREATE INDEX solicitations_issued_date_id_idx ON solicitations (issued_date, id);

-- Not yet wired to a `sort=` option (the API only exposes deadline/quantity/issued/relevance
-- right now) -- added per the same (column, id) pattern for when fsc-based sorting or
-- keyset-within-an-fsc-filter is needed.
CREATE INDEX solicitations_fsc_id_idx ON solicitations (fsc, id);
