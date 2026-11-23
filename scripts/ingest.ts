// CLI entry point for ingesting DIBBS RFQ listings into Postgres (and, per date, a JSON file).
// Run: npm run ingest [-- MM-DD-YYYY] [--dates MM-DD-YYYY,MM-DD-YYYY,...] [--max-pages N]
//      [--out data/sample.json] [--fetcher curl|playwright]
//
// With no date argument, defaults to a rolling window of the 7 most recent posting dates --
// this is what the nightly cron is expected to call, so a day it missed (a failed run, a
// deploy gap) still gets caught by the next run instead of leaving a permanent gap.
// --dates overrides that window with an explicit list; a single positional MM-DD-YYYY date
// is shorthand for --dates with exactly one date (same behavior as every earlier session in
// this project used, kept unchanged).
//
// Delegates the actual HTTP/browser work to scripts/fetchers/*.ts; this file only handles
// CLI args, per-date JSON output, and recording one ingest_runs row for the whole invocation.
// Playwright is the default fetcher -- see scripts/fetchers/curl.ts's header comment for why
// the curl fetcher is kept as a fallback.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { IngestResult } from "../lib/solicitation.ts";
import * as curlFetcher from "./fetchers/curl.ts";
import * as playwrightFetcher from "./fetchers/playwright.ts";

type FetcherName = "curl" | "playwright";
const ROLLING_WINDOW_SIZE = 7;
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;

interface CliArgs {
  date: string | null;
  dates: string[] | null;
  maxPages: number | null;
  out: string;
  fetcher: FetcherName;
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | null = null;
  let dates: string[] | null = null;
  let maxPages: number | null = null;
  let out = "data/solicitations.json";
  let fetcher: FetcherName = "playwright";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--max-pages") {
      const val = argv[++i];
      maxPages = Number(val);
      if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error(`--max-pages expects a positive integer, got "${val}"`);
      }
    } else if (arg === "--out") {
      out = argv[++i];
      if (!out) throw new Error("--out expects a file path");
    } else if (arg === "--fetcher") {
      const val = argv[++i];
      if (val !== "curl" && val !== "playwright") {
        throw new Error(`--fetcher expects "curl" or "playwright", got "${val}"`);
      }
      fetcher = val;
    } else if (arg === "--dates") {
      const val = argv[++i];
      if (!val) throw new Error("--dates expects a comma-separated MM-DD-YYYY list");
      dates = val.split(",").map((d) => d.trim());
      for (const d of dates) {
        if (!DATE_RE.test(d)) throw new Error(`--dates contains an invalid date: "${d}"`);
      }
    } else if (DATE_RE.test(arg)) {
      date = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (date && dates) throw new Error("Pass either a single date or --dates, not both");
  return { date, dates, maxPages, out, fetcher };
}

// Single-explicit-date runs keep writing to the --out path exactly as before (session-long
// existing behavior). Multi-date runs (the default window, or an explicit --dates list) write
// one file per date instead, since a single --out path can't hold more than one day's result.
function outPathFor(date: string, args: CliArgs, isSingleExplicit: boolean): string {
  if (isSingleExplicit) return args.out;
  const dir = path.dirname(args.out) === "." ? "data" : path.dirname(args.out);
  return path.join(dir, `solicitations-${date}.json`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isSingleExplicit = args.date !== null;

  console.log(`[ingest] Using fetcher: ${args.fetcher}`);

  let dates: string[];
  if (args.dates) {
    dates = args.dates;
    console.log(`[ingest] Using --dates: ${dates.join(", ")}`);
  } else if (args.date) {
    dates = [args.date];
    console.log(`[ingest] Using CLI-provided date: ${args.date}`);
  } else {
    dates = await curlFetcher.listRecentIssueDates(ROLLING_WINDOW_SIZE);
    console.log(`[ingest] No date given -- using rolling window of ${ROLLING_WINDOW_SIZE} most recent posting dates: ${dates.join(", ")}`);
  }
  if (args.maxPages !== null) {
    console.log(`[ingest] --max-pages ${args.maxPages}: this will be a partial sample run, not a full day's data.`);
  }

  const fetchDay = args.fetcher === "curl" ? curlFetcher.fetchDay : playwrightFetcher.fetchDay;
  const startedAt = new Date().toISOString();
  const dbEnabled = Boolean(process.env.DATABASE_URL);

  let rowsInserted = 0;
  let rowsUpdated = 0;
  let overallStatus: "complete" | "partial" | "failed" = "complete";
  let runError: string | null = null;

  for (const date of dates) {
    const outPath = path.resolve(process.cwd(), outPathFor(date, args, isSingleExplicit));
    await mkdir(path.dirname(outPath), { recursive: true });

    let result: IngestResult;
    try {
      result = await fetchDay(date, args.maxPages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        date,
        recordsFound: null,
        recordsFoundEnd: null,
        rows: [],
        fetchedAt: new Date().toISOString(),
        errors: [`Ingest failed before any rows were parsed: ${message}`],
        status: "partial",
      };
      await writeFile(outPath, JSON.stringify(result, null, 2));
      console.error(`[ingest] ${date} FAILED:`, result.errors[0]);
      overallStatus = "failed";
      runError = runError ? `${runError}; ${date}: ${message}` : `${date}: ${message}`;
      process.exitCode = 1;
      continue;
    }

    await writeFile(outPath, JSON.stringify(result, null, 2));

    console.log(`\n[ingest] Summary for ${date}`);
    console.log(`  status: ${result.status}`);
    console.log(`  recordsFound (start): ${result.recordsFound}`);
    console.log(`  recordsFound (end): ${result.recordsFoundEnd}`);
    console.log(`  rowsParsed: ${result.rows.length}`);
    console.log(`  errors: ${result.errors.length ? result.errors.join(" | ") : "none"}`);
    console.log(`  wrote: ${outPath}`);

    // "partial" (e.g. a completeness-check mismatch) is logged and recorded in ingest_runs,
    // but must NOT fail the run -- only a hard "failed" date (fetchDay threw, handled in the
    // catch block above) sets a non-zero exit code, so a nightly Action run only shows red for
    // an actual hard failure, not a day that came back merely incomplete.
    if (result.status === "partial" && overallStatus === "complete") overallStatus = "partial";

    // DB write is additive to the JSON file, not a replacement for it yet -- skips gracefully
    // (not a failure) when DATABASE_URL isn't configured, so ingest still works without Postgres.
    if (dbEnabled) {
      const { upsertSolicitations } = await import("./db/upsertSolicitations.ts");
      const dbSummary = await upsertSolicitations(result.rows);
      console.log(`  db: inserted=${dbSummary.inserted} updated=${dbSummary.updated} collisions=${dbSummary.collisions}`);
      rowsInserted += dbSummary.inserted;
      rowsUpdated += dbSummary.updated;
    } else {
      console.log("  db: skipped (DATABASE_URL not set)");
    }
  }

  const finishedAt = new Date().toISOString();
  console.log(`\n[ingest] Run summary: status=${overallStatus} dates=${dates.length} inserted=${rowsInserted} updated=${rowsUpdated}`);

  if (dbEnabled) {
    const { sql } = await import("../lib/db.ts");
    await sql`
      INSERT INTO ingest_runs (started_at, finished_at, dates_pulled, rows_inserted, rows_updated, status, error)
      VALUES (${startedAt}, ${finishedAt}, ${dates}, ${rowsInserted}, ${rowsUpdated}, ${overallStatus}, ${runError})
    `;
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[ingest] Unhandled error:", err);
  process.exitCode = 1;
});
