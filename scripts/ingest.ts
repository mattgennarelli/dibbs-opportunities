// CLI entry point for ingesting one day's DIBBS RFQ listings into data/solicitations.json.
// Run: npm run ingest [-- MM-DD-YYYY] [--max-pages N] [--out data/sample.json] [--fetcher curl|playwright]
//
// Delegates the actual HTTP/browser work to scripts/fetchers/*.ts; this file only handles
// CLI args and writing the result. Playwright is the default fetcher -- see
// scripts/fetchers/curl.ts's header comment for why the curl fetcher is kept as a fallback.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { IngestResult } from "../lib/solicitation.ts";
import * as curlFetcher from "./fetchers/curl.ts";
import * as playwrightFetcher from "./fetchers/playwright.ts";

type FetcherName = "curl" | "playwright";

interface CliArgs {
  date: string | null;
  maxPages: number | null;
  out: string;
  fetcher: FetcherName;
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | null = null;
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
    } else if (/^\d{2}-\d{2}-\d{4}$/.test(arg)) {
      date = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { date, maxPages, out, fetcher };
}

async function main() {
  const { date: cliDate, maxPages, out, fetcher } = parseArgs(process.argv.slice(2));

  console.log(`[ingest] Using fetcher: ${fetcher}`);
  const date = cliDate ?? (await curlFetcher.getLatestIssueDate());

  if (cliDate) {
    console.log(`[ingest] Using CLI-provided date: ${date}`);
  } else {
    console.log(`[ingest] Latest issue date from RfqDates.aspx: ${date}`);
  }
  if (maxPages !== null) {
    console.log(`[ingest] --max-pages ${maxPages}: this will be a partial sample run, not a full day's data.`);
  }

  const outPath = path.resolve(process.cwd(), out);
  await mkdir(path.dirname(outPath), { recursive: true });

  const fetchDay = fetcher === "curl" ? curlFetcher.fetchDay : playwrightFetcher.fetchDay;

  let result: IngestResult;
  try {
    result = await fetchDay(date, maxPages);
  } catch (err) {
    result = {
      date,
      recordsFound: null,
      recordsFoundEnd: null,
      rows: [],
      fetchedAt: new Date().toISOString(),
      errors: [`Ingest failed before any rows were parsed: ${err instanceof Error ? err.message : String(err)}`],
      status: "partial",
    };
    await writeFile(outPath, JSON.stringify(result, null, 2));
    console.error("[ingest] FAILED:", result.errors[0]);
    process.exitCode = 1;
    return;
  }

  await writeFile(outPath, JSON.stringify(result, null, 2));

  console.log("\n[ingest] Summary");
  console.log(`  date: ${result.date}`);
  console.log(`  status: ${result.status}`);
  console.log(`  recordsFound (start): ${result.recordsFound}`);
  console.log(`  recordsFound (end): ${result.recordsFoundEnd}`);
  console.log(`  rowsParsed: ${result.rows.length}`);
  console.log(`  errors: ${result.errors.length ? result.errors.join(" | ") : "none"}`);
  console.log(`  wrote: ${outPath}`);

  // DB write is additive to the JSON file, not a replacement for it yet -- skips gracefully
  // (not a failure) when DATABASE_URL isn't configured, so ingest still works without Postgres.
  if (process.env.DATABASE_URL) {
    const { upsertSolicitations } = await import("./db/upsertSolicitations.ts");
    const dbSummary = await upsertSolicitations(result.rows);
    console.log(
      `  db: inserted=${dbSummary.inserted} updated=${dbSummary.updated} collisions=${dbSummary.collisions}`
    );
    const { sql } = await import("../lib/db.ts");
    await sql.end();
  } else {
    console.log("  db: skipped (DATABASE_URL not set)");
  }

  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[ingest] Unhandled error:", err);
  process.exitCode = 1;
});
