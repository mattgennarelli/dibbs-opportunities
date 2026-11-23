# Notes

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
