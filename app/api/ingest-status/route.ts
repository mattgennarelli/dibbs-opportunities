// GET /api/ingest-status
//
// Backs the header's "Data updated <time> · latest posting <date>" line and its staleness
// warning. No query params -- this reflects the ingest pipeline's own state, not anything
// the caller filters.

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export async function GET() {
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
