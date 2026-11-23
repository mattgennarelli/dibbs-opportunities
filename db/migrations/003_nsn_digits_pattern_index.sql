-- Migration 003: supports GET /api/solicitations's NSN-prefix search ("5330-01" matching
-- "5330-01-xxx-xxxx").
--
-- The plain btree index on nsn_digits (migration 001) supports equality and range
-- comparisons, but NOT `LIKE 'prefix%'` under a non-C collation -- Postgres can only use a
-- btree index for a LIKE-prefix query if the index's operator class matches byte-for-byte
-- ("C" collation) comparison, which text_pattern_ops provides regardless of the column's
-- actual collation. Added alongside (not replacing) solicitations_nsn_digits_idx, which
-- still serves plain equality lookups.
CREATE INDEX solicitations_nsn_digits_pattern_idx ON solicitations (nsn_digits text_pattern_ops);
