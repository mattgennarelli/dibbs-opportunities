-- Migration 006: composite (nsn_digits, id) index for sort=nsn keyset pagination.
--
-- Migration 003 added a single-column text_pattern_ops index on nsn_digits for the
-- LIKE-prefix NSN search, but that index doesn't help ORDER BY nsn_digits, id (a plain
-- btree comparison, not a pattern match) -- this is the composite-with-id index every other
-- browse sort key already has (migration 001's return_by_date, migration 004's
-- quantity/issued_date/fsc).
CREATE INDEX solicitations_nsn_digits_id_idx ON solicitations (nsn_digits, id);
