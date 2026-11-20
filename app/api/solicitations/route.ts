import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { IngestResult } from "@/lib/solicitation";

// Serves whatever scripts/ingest.ts last wrote, as-is (no server-side filtering/sorting).
// Prefers the full day's data; falls back to the quick sample so the page still renders
// before a full ingest has ever completed.
const CANDIDATE_PATHS = ["data/solicitations.json", "data/sample.json"];

export async function GET() {
  for (const relativePath of CANDIDATE_PATHS) {
    const absolutePath = path.join(process.cwd(), relativePath);
    try {
      const raw = await readFile(absolutePath, "utf-8");
      const result: IngestResult = JSON.parse(raw);
      return NextResponse.json({ source: relativePath, ...result });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return NextResponse.json({ error: `Failed to read ${relativePath}: ${String(err)}` }, { status: 500 });
      }
      // ENOENT: try the next candidate.
    }
  }

  return NextResponse.json(
    { error: "No ingest data found. Run `npm run ingest` first." },
    { status: 404 }
  );
}
