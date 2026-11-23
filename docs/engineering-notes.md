# Notes

## Sub-line handling: full fix design, then generalized beyond First Article (2026-11-23)

Earlier versions mixed First Article Test (FA) line items (non-NSN rows marking the testing
step for a real-NSN line on the same solicitation) directly into the main rows query, nested
client-side. Two real bugs followed from that: an FA row could independently match
search/filters and show up as an unexplained standalone row, and a parent/FA pair could land
on different pages of a cursor walk (they competed for the same `LIMIT`/keyset cursor as
ordinary rows).

**Detection (FA specifically)**: initially matched only `nomenclature LIKE 'GOVERNMENT FIRST
ART%'`. Found live (SPE7L7-27-Q-0302) that a second variant exists -- "CONTRACTOR FIRST
ARTIC" (DIBBS truncates both to the same column width). Queried every other non-NSN
nomenclature in the table to make sure a broader `%FIRST ART%` pattern wouldn't over-match:
it doesn't.

**Generalization to "sub-lines"**: that same query surfaced other non-NSN categories that
aren't First Article at all -- `PRODUCTION LOT TESTING` (91 rows), `PRODUCTION CONTROL
TESTING` (2 rows), `NON-NSN ITEM` (57 rows), plus assorted raw-stock items (ANGLE, BEARING,
BUSHING, SPRING, ...). All of them have the exact same structural problem FA did: when they
share a solicitation with a real-NSN row, they need to travel with it, not compete with it.
The fix generalizes from "is this row an FA line" to "is this row a **sub-line**" -- any
non-NSN row (`nsn_digits IS NULL`) that has a real-NSN sibling on its solicitation
(`hasRealNsnSiblingSql`, `isSublineSql` in `lib/apiQuery.ts`). A non-NSN row with NO real-NSN
sibling (the only line item on its solicitation) is simply not a sub-line -- it stays an
ordinary standalone row, fully subject to filters/search like any other row, which also
retires the old "orphan FA" special case (separate query, first-page-only, "parent item not
listed" label) entirely: there's no orphan case left to handle, because a truly parentless
non-NSN row was never pulled out of the main query to begin with.

**Design**: `parentRowCondition` (`NOT isSublineSql`) is applied to the main rows/count/facets
query, always, regardless of `firstArticle` mode -- this is what keeps sub-lines out of
search/filter/sort/pagination entirely, and keeps totals/facet counts "parent rows only." One
supplementary query per request, scoped by `solicitation_number_raw = ANY(<this page's parent
solicitation numbers>)` and `isSublineSql` (so a parent and ALL its sub-lines -- FA, Lot
Testing, whatever else -- always arrive in the same HTTP response, never split across a
cursor walk), fetches every sub-line kind at once. Assembled into the final row list
server-side by `lib/firstArticle.ts`'s `withSublinesAssembled`, a plain function with no SQL
dependency -- fully unit-testable, see `tests/firstArticle.test.ts`.

Two specific flags stay narrower than "is a sub-line," each its own self-inclusive EXISTS
(so a standalone line of that kind still matches its own filter/flag on its own merit, no
special-casing needed):
- `IS_FIRST_ARTICLE_SQL` / `hasFirstArticleLineSql` -- unchanged from the original fix, drives
  the "First Article" parent flag and the `firstArticle` include/exclude/only filter.
- `IS_LOT_TESTING_SQL` / `hasLotTestingLineSql` -- added 2026-11-23, drives a new "Lot
  Testing" parent flag (distinct color from First Article). Matches `%PRODUCTION LOT TEST%`
  only -- deliberately NOT `PRODUCTION CONTROL TESTING`, which is a distinct, unverified
  category (what it actually represents hasn't been confirmed) and stays an unflagged nested
  sub-line. `LOT_TESTING_SUBSTRING` is exported from `lib/firstArticle.ts` and imported into
  `lib/apiQuery.ts` so the SQL `LIKE` pattern and its pure-JS mirror
  (`isLotTestingNomenclature`, used in tests) share one literal and can't drift apart.
  Production Lot Testing is DLAD 46.291: a quality test of the production lot before
  acceptance, priced as a separate CLIN, following First Article approval when FAT applies.
  No new filter was added for it -- just the flag.

All of these EXISTS fragments correlate on `solicitation_number_raw`, which had no index
before this feature -- added in migration `009_solicitation_number_raw_index.sql`.

**Known follow-up, not done here**: `PRODUCTION CONTROL TESTING` (2 rows) still has no flag,
pending confirmation of what it actually represents -- same mechanism as Lot Testing would
apply once that's known.

## Keyset vs. `OFFSET` pagination, measured head-to-head (2026-11-23)

README cites this table for the keyset-pagination decision. Query: `sort=quantity&dir=desc`
over `open_solicitations` (~14,025 open rows at the time of this run), `EXPLAIN (ANALYZE,
BUFFERS)`, `LIMIT 51` (matching the app's real limit+1 lookahead), 3 runs each, median taken.
Full queries and script in `scratch/investigate/explain_keyset_vs_offset.ts` (gitignored —
not committed, reproducible locally against a populated DB).

| Depth | `OFFSET` (median of 3) | keyset cursor (median of 3) |
|---|---|---|
| page 40 (`OFFSET 1950`) | 2.12ms (runs: 2.155, 2.054, 2.122) | 1.38ms (runs: 1.370, 1.386, 1.382) |
| page 200 (`OFFSET 9950`) | 12.84ms (runs: 12.842, 13.473, 12.673) | 5.79ms (runs: 6.059, 5.455, 5.791) |

What the plans actually show, since the headline numbers alone overstate the mechanism:

- At page 40, both queries use the same index (`solicitations_quantity_desc_id_idx`) and
  examine a similar number of rows (`OFFSET`: `rows=2001` before the `Limit`/`Offset` cut;
  keyset: `Rows Removed by Filter: 2272` before 51 matches). `OFFSET` is slower because it
  still materializes and discards the first ~1,950 rows through the `Limit` node; keyset's
  predicate filters them out before they get that far.
- At page 200, the planner switches `OFFSET`'s plan to a sequential scan plus an explicit
  `Sort` of the full ~10,001-row matching set before taking the top 51 — that `Sort` step
  alone (`Sort Method: quicksort`) takes ~12.4ms of the ~12.84ms total. Keyset's plan stays
  an ordered `Index Scan` (`Rows Removed by Filter: 11835`, no `Sort` node), which is why its
  cost keeps growing roughly with depth instead of jumping to "sort everything."
- On this nullable column, the cursor predicate is `quantity IS NULL OR (quantity, id) <
  (cursor)`, which Postgres cannot push down as a true index-seek `Index Cond` (it shows as a
  `Filter`, not an `Index Cond`) — so keyset pagination here is NOT "jump straight to the
  cursor's position." Its advantage at this table size is specifically avoiding `OFFSET`'s
  full materialize-and-discard (shallow pages) and its full explicit sort (deep pages), not an
  index seek that skips examining prior rows entirely.

## DIBBS daily RFQ flat-file index (investigated 2026-11-23)

Checked whether DIBBS exposes a flat per-date index file as an alternative to
postback paging (lead: third-party scrapers like Apify's "DIBBS RFQ Scraper").

- Found: `https://dibbs2.bsm.dla.mil/Downloads/RFQ/Archive/in{YYMMDD}.txt`
  (e.g. `in261120.txt`), linked from `AcqDownloads/` -> `RFQ/RFQDates.aspx?category=recent`.
  Also `bq{date}.zip` / `ca{date}.zip` per date (contents not inspected).
- Separate subdomain (`dibbs2.bsm.dla.mil`) from the main site, with its own
  DOD-warning consent/session flow — cookies don't carry over from
  `www.dibbs.bsm.dla.mil`.
- Fixed-width text, CRLF, `Content-Disposition: attachment`. Readable fields
  by inspection: solicitation number, NSN (-> FSC), a PR-like number,
  return-by date, document filename, qty+unit, nomenclature. Byte offsets
  and a trailing buyer/AMSC/set-aside code block are NOT yet decoded.
- **Not adopted**: for 11-20-2026, `in261120.txt` has 1,309 rows vs. the live
  grid's reported 4,399 "Records Found" — a ~70% gap with no identified
  cause (not a type-code exclusion: rows split 83 Q / 1,199 T / 27 U). Also
  note the grid's own count for 11-20-2026 grew from an expected ~3,848 (per
  the original third-party lead) to 4,399 by 2026-11-23 — a ~4-day-old
  solicitation's record count is not stable, which matters for any caching
  assumptions. Given CLAUDE.md's correctness-first rule, treating this file
  as the ingest source risked a silent ~70% undercount. Decision: keep using
  postback paging (Alternative 1); revisit the flat file later if the
  `bq`/`ca` zips turn out to contain the missing records.
