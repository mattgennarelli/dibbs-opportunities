# DIBBS Opportunities

A client-facing view of open DLA DIBBS RFQs (government solicitations for distributors and
manufacturers), scraped from the public [DIBBS](https://www.dibbs.bsm.dla.mil/) site into a
filterable, sortable table.

## Running it

```bash
npm install
npx playwright install chromium  # one-time: downloads the browser ingest uses
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The page reads `data/solicitations.json`
if present, else falls back to the committed `data/sample.json` so it never shows a blank page.

## How ingest works

`npm run ingest [-- MM-DD-YYYY] [--max-pages N] [--out data/sample.json] [--fetcher curl|playwright]`
(see [scripts/ingest.ts](scripts/ingest.ts)) scrapes one day's RFQ listing:

1. Resolves the latest issue date from `RfqDates.aspx` (or uses the `MM-DD-YYYY` arg).
2. Fetches the results grid on `RfqRecs.aspx` and pages through it, parsing rows with regex
   (no HTML-parser dependency, shared by both fetchers via `lib/parseRfqGrid.ts`), and writes
   the result to `data/solicitations.json`.

**Fetcher: `playwright` (default)** — drives a real headless Chromium browser through the
site's own pagination (clicking the page-number links), since replaying the `Page$N` ASP.NET
postback by hand (see below) turned out not to be fixable. Needs the one-time
`npx playwright install chromium` setup step above.

**Fetcher: `curl`** (`--fetcher curl`) — the original approach: shells out to the system
`curl` binary (Node's built-in `fetch` gets rejected outright by DIBBS's WAF) and replays the
ASP.NET `__doPostBack` form post by hand, carrying `__VIEWSTATE`/`__EVENTVALIDATION` forward
from each response. Kept as a fallback and for the cheap `RfqDates.aspx` date lookup (a GET,
unaffected by the issue below). **Known broken for paging**: investigated 2026-11-23 — the
`Page$N` postback reliably returns a 200 OK with page 1's exact content again instead of
advancing, and this was bisected exhaustively (headers, cookies, body field order, URL
encoding) with no fix found at the HTTP level; see `NOTES.md`. Don't rely on this fetcher for
anything beyond page 1 of a day's results.

## Filters

All client-side, over whatever's loaded: free-text search (NSN with or without dashes,
nomenclature, solicitation #), FSC dropdown with counts, Fast Award / small-business
set-aside toggles, min quantity, "has tech docs", "closing within N days", and a "Clear all"
button. Default sort is return-by date, soonest first.

## Known limitations

- The `curl` fetcher's pagination is broken (see above) — use the default `playwright`
  fetcher for anything beyond a one-page sample.
- The Playwright fetcher's pager-window-rollover logic (clicking "..." to reach page numbers
  beyond the first visible window of ~10) is implemented but has only been exercised up to
  page 3 of a sample run; a full ~88-page day hasn't yet confirmed the rollover across many
  window boundaries.
- A small number of line items (e.g. "First Article" rows) carry a reference number instead
  of a real NSN and have no catalog link; `fsc` for those rows is still mechanically derived
  from the first 4 characters of that reference number, which is not a meaningful FSC. Not
  fixed in this slice — flagging so it isn't mistaken for a real FSC later.
- Checked whether DIBBS exposes a flat per-date index file as an alternative to UI scraping
  entirely; not adopted due to an unexplained ~70% row-count gap. See `NOTES.md`.
