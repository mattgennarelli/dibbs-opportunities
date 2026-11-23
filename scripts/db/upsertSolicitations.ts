// Writes a day's parsed rows into Postgres via a single batched upsert transaction.
// Called by scripts/ingest.ts in addition to (not instead of) the JSON file write.

import type { Solicitation } from "../../lib/solicitation.ts";
import { parseIsoDate, rowKey } from "../../lib/parseRfqGrid.ts";
import { sql } from "../../lib/db.ts";

// Postgres has a 65,535-bound-parameter limit per statement; a full day is ~4,400 rows x
// 19 columns =~ 83,000 params, well over that. 500 rows/chunk x 19 columns = 9,500 params,
// comfortably under the limit with room to spare -- not a tight-as-possible max, a safe
// round number.
const CHUNK_SIZE = 500;

const DB_COLUMNS = [
  "nsn",
  "nsn_raw",
  "nsn_digits",
  "nomenclature",
  "technical_documents",
  "solicitation_number",
  "solicitation_number_raw",
  "document_url",
  "status",
  "purchase_request_number",
  "quantity",
  "issued_date",
  "return_by_date",
  "badges",
  "package_view_url",
  "source_date",
  "fetched_at",
  "fsc",
  "solicitation_type",
] as const;

interface DbRow {
  row_key: string;
  nsn: string;
  nsn_raw: string;
  nsn_digits: string | null;
  nomenclature: string;
  technical_documents: string | null;
  solicitation_number: string;
  solicitation_number_raw: string;
  document_url: string | null;
  status: string;
  purchase_request_number: string | null;
  quantity: number | null;
  issued_date: string | null;
  return_by_date: string | null;
  badges: string[];
  package_view_url: string;
  source_date: string;
  fetched_at: string;
  fsc: string | null;
  solicitation_type: string | null;
}

function toDbRow(row: Solicitation): DbRow {
  // row.sourceDate is the CLI's MM-DD-YYYY date string (see scripts/ingest.ts), not ISO --
  // Postgres's `date` type needs YYYY-MM-DD.
  const sourceDateIso = parseIsoDate(row.sourceDate);
  if (!sourceDateIso) {
    throw new Error(`Row for solicitation ${row.solicitationNumberRaw} has an unparseable sourceDate: "${row.sourceDate}"`);
  }
  return {
    row_key: rowKey(row),
    nsn: row.nsn,
    nsn_raw: row.nsnRaw,
    nsn_digits: row.nsnDigits,
    nomenclature: row.nomenclature,
    technical_documents: row.technicalDocuments,
    solicitation_number: row.solicitationNumber,
    solicitation_number_raw: row.solicitationNumberRaw,
    document_url: row.documentUrl,
    status: row.status,
    purchase_request_number: row.purchaseRequestNumber,
    quantity: row.quantity,
    issued_date: row.issuedDate,
    return_by_date: row.returnByDate,
    badges: row.badges,
    package_view_url: row.packageViewUrl,
    source_date: sourceDateIso,
    fetched_at: row.fetchedAt,
    fsc: row.fsc,
    solicitation_type: row.solicitationType,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface UpsertSummary {
  inserted: number;
  updated: number;
  collisions: number;
}

// Dedupes by row_key before touching the DB, keeping the last-seen row for a given key and
// logging every collision with both rows' full content -- row_key collisions within a
// single ingest run shouldn't happen (the playwright fetcher already guards against
// cross-page duplicates), so seeing one here signals a parser bug, not normal operation.
function dedupeByRowKey(rows: Solicitation[]): Solicitation[] {
  const byKey = new Map<string, Solicitation>();
  for (const row of rows) {
    const key = rowKey(row);
    const existing = byKey.get(key);
    if (existing) {
      console.warn(
        `[upsert] row_key collision "${key}" -- keeping the later row, dropping the earlier one. ` +
          `This should not happen; it signals a parser bug.`
      );
      console.warn("[upsert]   earlier row:", JSON.stringify(existing));
      console.warn("[upsert]   later row:  ", JSON.stringify(row));
    }
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

export async function upsertSolicitations(rows: Solicitation[]): Promise<UpsertSummary> {
  const deduped = dedupeByRowKey(rows);
  const collisions = rows.length - deduped.length;
  const dbRows = deduped.map(toDbRow);

  let inserted = 0;
  let updated = 0;

  // One transaction for the whole run: either every chunk lands, or (on failure) none do --
  // a half-written day is worse than no write, since the JSON file is still the fallback
  // source of truth for the UI.
  await sql.begin(async (tx) => {
    for (const batch of chunk(dbRows, CHUNK_SIZE)) {
      const keys = batch.map((r) => r.row_key);
      // Counted before the upsert touches anything, so "existing" unambiguously means
      // "existing going into this chunk" -- not affected by the upsert we're about to run.
      const existing = await tx`SELECT row_key FROM solicitations WHERE row_key = ANY(${keys})`;
      const existingCount = existing.length;
      inserted += batch.length - existingCount;
      updated += existingCount;

      // row_key is a GENERATED column -- Postgres computes it itself from
      // solicitation_number_raw/nsn_digits/nsn_raw/purchase_request_number, which are
      // already in DB_COLUMNS, so it's deliberately excluded from the insert column list.
      await tx`
        INSERT INTO solicitations ${tx(batch, ...DB_COLUMNS)}
        ON CONFLICT (row_key) DO UPDATE SET
          nsn                 = EXCLUDED.nsn,
          nsn_raw             = EXCLUDED.nsn_raw,
          nsn_digits          = EXCLUDED.nsn_digits,
          nomenclature        = EXCLUDED.nomenclature,
          technical_documents = EXCLUDED.technical_documents,
          document_url        = EXCLUDED.document_url,
          status              = EXCLUDED.status,
          quantity            = EXCLUDED.quantity,
          issued_date         = EXCLUDED.issued_date,
          return_by_date      = EXCLUDED.return_by_date,
          badges              = EXCLUDED.badges,
          package_view_url    = EXCLUDED.package_view_url,
          fsc                 = EXCLUDED.fsc,
          solicitation_type   = EXCLUDED.solicitation_type,
          -- Always bumped: this run saw the row again, regardless of whether anything changed.
          fetched_at          = EXCLUDED.fetched_at,
          last_seen_at        = now(),
          -- Gated: only moves forward when a real field actually differs from what's stored
          -- now. Comparing the two rows as composite values via IS DISTINCT FROM is the
          -- concise idiom for "did any of these columns change" without N separate OR clauses.
          updated_at = CASE
            WHEN (
              solicitations.nsn, solicitations.nsn_raw, solicitations.nsn_digits,
              solicitations.nomenclature, solicitations.technical_documents,
              solicitations.document_url, solicitations.status, solicitations.quantity,
              solicitations.issued_date, solicitations.return_by_date, solicitations.badges,
              solicitations.package_view_url, solicitations.fsc, solicitations.solicitation_type
            ) IS DISTINCT FROM (
              EXCLUDED.nsn, EXCLUDED.nsn_raw, EXCLUDED.nsn_digits,
              EXCLUDED.nomenclature, EXCLUDED.technical_documents,
              EXCLUDED.document_url, EXCLUDED.status, EXCLUDED.quantity,
              EXCLUDED.issued_date, EXCLUDED.return_by_date, EXCLUDED.badges,
              EXCLUDED.package_view_url, EXCLUDED.fsc, EXCLUDED.solicitation_type
            )
            THEN now()
            ELSE solicitations.updated_at
          END
      `;
    }
  });

  return { inserted, updated, collisions };
}
