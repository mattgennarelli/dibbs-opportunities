// GET /api/facets?q=...&fastAward=true&...
//
// FSC counts for the current set of filters, EXCLUDING fsc itself -- these answer "if I
// also filtered by this FSC, how many rows would I get," given whatever else is already
// selected. Accepts the same query params as /api/solicitations except fsc/sort/cursor/limit
// (which don't apply to a facet listing), validated by the same QuerySchema so "what counts
// as a match" can never disagree between the two routes.

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { QuerySchema, rawQueryFromSearchParams, buildFilterConditions } from "@/lib/apiQuery";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // fsc/sort/cursor/limit are accepted (harmlessly ignored) rather than rejected, except
  // sort=relevance's own requirement that q be present -- QuerySchema is reused as-is rather
  // than maintaining a second, nearly-identical schema.
  const parsed = QuerySchema.safeParse(rawQueryFromSearchParams(searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, { status: 400 });
  }
  const query = parsed.data;

  const filters = {
    q: query.q,
    fastAward: query.fastAward,
    smallBusiness: query.smallBusiness,
    techDocs: query.techDocs,
    minQty: query.minQty,
    closingWithinDays: query.closingWithinDays,
  };

  const facets = await sql.begin(async (tx) => {
    await tx`SET LOCAL pg_trgm.word_similarity_threshold = 0.3`;
    return tx<{ fsc: string; count: string }[]>`
      SELECT fsc, COUNT(*)::bigint AS count
      FROM open_solicitations
      WHERE ${buildFilterConditions(sql, filters)}
        AND fsc IS NOT NULL
      GROUP BY fsc
      ORDER BY fsc
    `;
  });

  return NextResponse.json({
    facets: facets.map((f) => ({ fsc: f.fsc, count: Number(f.count) })),
  });
}
