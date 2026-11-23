// GET /api/solicitations?q=...&fsc=1234&fsc=5678&fastAward=true&sort=deadline&cursor=...&limit=50
//
// Replaces the old JSON-file-passthrough version: this is the real, filtered, paginated,
// Postgres-backed endpoint described in NOTES.md's "Step 3a" entry. Base set is always the
// open_solicitations view (ET "today" -- see db/migrations/001_init.sql's comment on it).
//
// Two mutually exclusive modes, chosen by `sort`:
// - "deadline" | "quantity" | "issued" (default: "deadline"; "browse mode"): keyset
//   pagination on (that column, id) -- see lib/apiQuery.ts's BROWSE_SORT_SPECS. `q`, if
//   present, is still a WHERE filter here -- it just doesn't drive the ordering.
// - "relevance" ("search mode", requires `q`): results ranked by match quality, offset-
//   paginated within the top 200 candidates. See lib/apiQuery.ts's header comments for why
//   these two need genuinely different cursor shapes.

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { dbRowToSolicitation, type SolicitationDbRow } from "@/lib/dbRow";
import {
  QuerySchema,
  rawQueryFromSearchParams,
  decodeCursor,
  encodeCursor,
  buildFilterConditions,
  fscCondition,
  isNsnLooking,
  browseOrderBy,
  browseKeysetCondition,
  type BrowseCursor,
  type BrowseSortKey,
  type SearchCursor,
} from "@/lib/apiQuery";

// Every rows query selects exactly these columns, with date/timestamp columns cast to text
// so postgres.js returns plain strings (its default JS Date objects don't match the
// Solicitation type's "YYYY-MM-DD"/ISO-string contract the rest of the app already relies on).
const ROW_COLUMNS = sql`
  nsn, nsn_raw, nsn_digits, nomenclature, technical_documents,
  solicitation_number, solicitation_number_raw, document_url, status,
  has_attachments, purchase_request_number, quantity,
  issued_date::text, return_by_date::text, badges, package_view_url,
  source_date::text, fetched_at::text, fsc, solicitation_type
`;

const SEARCH_CAP = 200;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse(rawQueryFromSearchParams(searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, { status: 400 });
  }
  const query = parsed.data;

  let cursor: BrowseCursor | SearchCursor | null = null;
  if (query.cursor !== undefined) {
    cursor = decodeCursor(query.cursor);
    const invalid =
      cursor === null ||
      (query.sort === "relevance" ? cursor.type !== "search" : cursor.type !== "browse" || cursor.sortKey !== query.sort);
    if (invalid) {
      return NextResponse.json({ error: `Invalid cursor for sort=${query.sort}` }, { status: 400 });
    }
  }

  const filters = {
    q: query.q,
    fastAward: query.fastAward,
    smallBusiness: query.smallBusiness,
    techDocs: query.techDocs,
    minQty: query.minQty,
    closingWithinDays: query.closingWithinDays,
  };

  // SET LOCAL only lasts for the current transaction -- both the rows query and the count
  // query need the same threshold applied, so they run inside one transaction together
  // rather than each opening (and losing) their own SET LOCAL.
  const result = await sql.begin(async (tx) => {
    await tx`SET LOCAL pg_trgm.word_similarity_threshold = 0.3`;

    const where = sql`${fscCondition(sql, query.fsc)} AND ${buildFilterConditions(sql, filters)}`;

    const total = (await tx`SELECT COUNT(*)::bigint AS total FROM open_solicitations WHERE ${where}`)[0].total as bigint;

    if (query.sort === "relevance") {
      // query.q is guaranteed defined here -- QuerySchema.refine() rejects sort=relevance
      // without it.
      const q = query.q as string;
      const offset = (cursor as SearchCursor | null)?.offset ?? 0;
      const rows = await tx<SolicitationDbRow[]>`
        SELECT * FROM (
          SELECT ${ROW_COLUMNS},
            CASE WHEN ${isNsnLooking(q)} THEN NULL ELSE word_similarity(${q}::text, nomenclature) END AS rank,
            id
          FROM open_solicitations
          WHERE ${where}
          ORDER BY
            CASE WHEN ${isNsnLooking(q)} THEN nsn_digits ELSE NULL END ASC,
            rank DESC NULLS LAST,
            id ASC
          LIMIT ${SEARCH_CAP}
        ) capped
        OFFSET ${offset}::int
        LIMIT ${query.limit}::int
      `;
      const cappedTotal = total > SEARCH_CAP ? SEARCH_CAP : Number(total);
      const nextOffset = offset + rows.length;
      const nextCursor = nextOffset < cappedTotal ? encodeCursor({ type: "search", offset: nextOffset }) : null;
      return {
        rows: rows.map(dbRowToSolicitation),
        nextCursor,
        total: Number(total),
        capped: total > SEARCH_CAP,
      };
    }

    // Browse mode: fetch limit+1 so "is there a next page" is answered by this same query,
    // never a second round-trip.
    const sortKey = query.sort as BrowseSortKey; // narrowed: "relevance" handled above
    const browseCursor = cursor as BrowseCursor | null;
    const rows = await tx<(SolicitationDbRow & { id: number })[]>`
      SELECT ${ROW_COLUMNS}, id
      FROM open_solicitations
      WHERE ${where} AND ${browseKeysetCondition(sql, sortKey, browseCursor)}
      ORDER BY ${browseOrderBy(sql, sortKey)}
      LIMIT ${query.limit + 1}::int
    `;
    const hasNextPage = rows.length > query.limit;
    const pageRows = hasNextPage ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasNextPage && last) {
      const v = sortKey === "deadline" ? last.return_by_date : sortKey === "quantity" ? last.quantity : last.issued_date;
      // postgres.js returns bigint columns (id) as strings to avoid silent precision loss
      // on values beyond Number.MAX_SAFE_INTEGER -- converted back to a number here since
      // this app's row counts are nowhere near that range, and the cursor JSON needs a
      // real number (decodeCursor's typeof check rejects a string id as malformed).
      nextCursor = encodeCursor({ type: "browse", sortKey, v, id: Number(last.id) });
    }
    return {
      rows: pageRows.map(dbRowToSolicitation),
      nextCursor,
      total: Number(total),
    };
  });

  return NextResponse.json(result);
}
