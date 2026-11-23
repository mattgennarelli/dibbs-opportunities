// GET /api/ingest-status
//
// Backs the header's "Data updated <time> · latest posting <date>" line and its staleness
// warning. No query params -- this reflects the ingest pipeline's own state, not anything
// the caller filters.

import { NextResponse, connection } from "next/server";
import { sql } from "@/lib/db";

export async function GET() {
  // connection() opts this route into dynamic rendering under cacheComponents -- the
  // Cache-Components-compatible replacement for `export const dynamic = "force-dynamic"`
  // (which is explicitly rejected when cacheComponents is on). Without it, this handler has
  // no request-based signal (no params, no request.url) so Next's static analysis treats it
  // as prerenderable and actually RUNS it at build time, where DATABASE_URL isn't set.
  await connection();

  const [lastRun] = await sql<
    { started_at: string; finished_at: string; status: string; error: string | null }[]
  >`
    SELECT started_at::text, finished_at::text, status, error
    FROM ingest_runs
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const [latest] = await sql<{ latest_source_date: string | null }[]>`
    SELECT MAX(source_date)::text AS latest_source_date FROM solicitations
  `;

  return NextResponse.json({
    lastRun: lastRun ?? null,
    latestSourceDate: latest?.latest_source_date ?? null,
  });
}
