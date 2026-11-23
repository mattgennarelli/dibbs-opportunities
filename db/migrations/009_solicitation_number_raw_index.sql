-- Migration 009: index for First Article Test parent/child lookups.
--
-- The First Article feature (lib/apiQuery.ts's hasFirstArticleLineSql /
-- hasNonFirstArticleParentSql, used by app/api/solicitations/route.ts and
-- app/api/facets/route.ts) runs a correlated EXISTS subquery keyed on
-- solicitation_number_raw for every candidate row -- "does this solicitation have an FA
-- line?" / "does this FA line have a real-NSN parent?" -- plus a direct `= ANY(...)` lookup
-- to fetch a page's FA children. Without an index, every one of those is a sequential scan.
CREATE INDEX solicitations_solicitation_number_raw_idx ON solicitations (solicitation_number_raw);
