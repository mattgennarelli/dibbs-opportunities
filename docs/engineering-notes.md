# Notes

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
