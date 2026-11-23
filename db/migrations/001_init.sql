-- Migration 001: initial schema for DIBBS solicitations.
-- schema_migrations itself is created by scripts/migrate.ts before this file
-- (or any migration file) ever runs -- it's bootstrap infrastructure for the
-- migration runner, not part of the app's own schema, so it doesn't belong here.

-- pg_trgm: Postgres extension that indexes text as overlapping 3-char
-- "trigrams," enabling fast ILIKE '%term%' and fuzzy similarity search
-- on nomenclature (see the GIN index further down).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One row per DIBBS RFQ line item (one solicitation can have several line
-- items -- different NSN/PR# combinations -- hence the composite row_key below,
-- not solicitation_number alone).
CREATE TABLE solicitations (
  -- Surrogate key. Used (not row_key) in the pagination index below because
  -- it's a plain monotonically-ordered integer -- cheaper for cursor comparisons
  -- than comparing the text row_key.
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Display NSN text exactly as scraped, e.g. "8455-01-743-3421" --
  -- or a non-NSN reference number like "0001S00000053" for First Article rows.
  nsn text NOT NULL,
  -- Raw NSN/reference-number cell text, always present -- same value as nsn
  -- today, kept as its own column so "nsn" stays free to mean "a real NSN or
  -- null" later without a migration, per lib/solicitation.ts's existing split.
  nsn_raw text NOT NULL,
  -- 13-digit NSN with dashes stripped, or NULL when nsn isn't a real NSN --
  -- never derived from a non-NSN reference number (CLAUDE.md: never invent values).
  nsn_digits text,
  -- Item description as DIBBS displays it, e.g. "BADGE,QUALIFICATION".
  nomenclature text NOT NULL,
  -- 'none', 'present', or NULL if the cell's content didn't match either case.
  technical_documents text,
  -- Display solicitation number, e.g. "SPE1C1-27-Q-0209".
  solicitation_number text NOT NULL,
  -- Unformatted solicitation number as used in DIBBS's own URLs, e.g. "SPE1C127Q0209".
  solicitation_number_raw text NOT NULL,
  -- Link to the solicitation's document, or NULL if the row had none.
  document_url text,
  -- Free-text status label exactly as DIBBS renders it (e.g. "Open").
  status text NOT NULL,
  -- Purchase request number, or NULL -- some rows don't have one.
  purchase_request_number text,
  -- Requested quantity, or NULL if the PR/QTY cell didn't parse.
  quantity integer,
  -- Date DIBBS issued this RFQ, or NULL if unparsed.
  issued_date date,
  -- Date quotes are due, or NULL if unparsed -- the main sort/filter column.
  return_by_date date,
  -- Badge icons shown on the row (fastAward, unrestricted, smallBusinessSetAside,
  -- other), as a plain array -- small enough per row that a join table isn't worth it.
  badges text[] NOT NULL DEFAULT '{}',
  -- Link to view the full solicitation package.
  package_view_url text NOT NULL,
  -- The DIBBS "issue date" this row was scraped under (the day ingest targeted),
  -- not the same thing as issued_date above (which is this specific RFQ's own date).
  source_date date NOT NULL,
  -- Timestamp of the ingest run that most recently scraped this exact row content.
  -- Unlike last_seen_at below, this always moves forward every run, gated or not.
  fetched_at timestamptz NOT NULL,
  -- First 4 digits of nsn_digits, or NULL when nsn_digits is NULL -- never
  -- derived from a non-NSN reference number.
  fsc text,
  -- 'automated', 'buyerGenerated', 'other', or NULL -- derived from the 9th
  -- character of solicitation_number_raw.
  solicitation_type text,

  -- Composite identity for "this exact line item," mirroring the client's own
  -- rowKey() in lib/parseRfqGrid.ts so DB and app never disagree on what counts
  -- as "the same row." COALESCE handles NULLs explicitly: SQL NULL <> NULL, so
  -- an un-coalesced composite would let two rows with matching solicitation+NSN
  -- but both-NULL purchase_request_number be treated as "different," silently
  -- reintroducing duplicates on every PR#-less row.
  row_key text GENERATED ALWAYS AS (
    solicitation_number_raw || '|' ||
    COALESCE(nsn_digits, nsn_raw) || '|' ||
    COALESCE(purchase_request_number, '')
  ) STORED,

  -- When this exact row_key was first ever seen by any ingest run.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- When this row_key was most recently seen by an ingest run, whether or not
  -- any of its data actually changed -- bumped unconditionally every run, same
  -- as fetched_at.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- When this row's actual data last changed. Unlike last_seen_at, this is
  -- gated: the upsert only touches it when a real field differs from what's
  -- already stored, so "still open, nothing changed" runs don't bump it.
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Enforces the identity from row_key: one row per (solicitation, NSN-or-ref,
  -- PR#) combination. This is also the ON CONFLICT target for the upsert.
  CONSTRAINT solicitations_row_key_key UNIQUE (row_key)
);

-- Main access pattern: open RFQs across all dates, sorted by return_by_date.
-- (id) is appended for cursor pagination later -- ties on return_by_date (common,
-- many RFQs close the same day) need a second column to give every row a stable,
-- unique position to page from.
CREATE INDEX solicitations_return_by_date_id_idx ON solicitations (return_by_date, id);

-- FSC dropdown filter and per-FSC counts in the UI.
CREATE INDEX solicitations_fsc_idx ON solicitations (fsc);

-- Every ingest run and most day-scoped queries filter by source_date.
CREATE INDEX solicitations_source_date_idx ON solicitations (source_date);

-- NSN-based lookups/search (digits-only, so dash formatting doesn't matter).
CREATE INDEX solicitations_nsn_digits_idx ON solicitations (nsn_digits);

-- GIN trigram index: enables fast ILIKE '%term%' and fuzzy similarity() matches
-- on nomenclature, instead of a full-table scan for every search keystroke.
CREATE INDEX solicitations_nomenclature_trgm_idx ON solicitations USING GIN (nomenclature gin_trgm_ops);

-- "Today," everywhere in this app, means the current date in US Eastern time
-- (where DLA's business day runs), not UTC -- a return_by_date of today should
-- stop counting as "open" at Eastern midnight, not UTC midnight. This is the
-- one place that rule is defined in SQL; any future query/view needing "today"
-- should reuse (now() AT TIME ZONE 'America/New_York')::date rather than
-- re-deriving it, so a timezone fix only ever has to happen in one place.
CREATE VIEW open_solicitations AS
SELECT *
FROM solicitations
WHERE return_by_date >= (now() AT TIME ZONE 'America/New_York')::date
  AND status = 'Open';
