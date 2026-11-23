// GET /api/facets?q=...&fastAward=true&...
//
// Live counts for two dropdowns, each computed with every filter EXCEPT that dropdown's own
// current selection -- the standard faceted-search rule ("if I also picked this option, how
// many rows would I get," given everything else already chosen):
// - fsc counts exclude the fsc filter, but include setAside (and vice versa for setAside
//   counts) -- each facet's query independently omits only its own filter.
// Accepts the same query params as /api/solicitations except sort/cursor/limit (which don't
// apply to a facet listing), validated by the same QuerySchema so "what counts as a match"
// can never disagree between the two routes.

import { NextResponse, connection } from "next/server";
import { sql } from "@/lib/db";
import { QuerySchema, rawQueryFromSearchParams, buildFilterConditions, fscCondition, postedCondition, firstArticleCondition, SET_ASIDE_VALUES } from "@/lib/apiQuery";


export async function GET(request: Request) {
  // Explicit dynamic opt-in (see app/api/ingest-status/route.ts's comment) -- reading
  // request.url below already implies this, but that's a Next heuristic, not a guarantee.
  await connection();
  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse(rawQueryFromSearchParams(searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, { status: 400 });
  }
  const query = parsed.data;

  const filters = {
    q: query.q,
    fastAward: query.fastAward,
    setAside: query.setAside,
    techDocs: query.techDocs,
    minQty: query.minQty,
    closingWithinDays: query.closingWithinDays,
  };

  const { fscFacets, setAsideFacets } = await sql.begin(async (tx) => {
    await tx`SET LOCAL pg_trgm.word_similarity_threshold = 0.3`;

    // fsc facet: every filter including setAside, fsc itself omitted.
    const fscFacets = await tx<{ fsc: string; count: string }[]>`
      SELECT fsc, COUNT(*)::bigint AS count
      FROM open_solicitations
      WHERE ${postedCondition(sql, query.posted)} AND ${firstArticleCondition(sql, query.firstArticle)} AND ${buildFilterConditions(sql, filters)}
        AND fsc IS NOT NULL
      GROUP BY fsc
      ORDER BY fsc
    `;

    // setAside facet: every filter including fsc, setAside itself omitted. Always returns
    // all SET_ASIDE_VALUES (LEFT JOIN against a literal VALUES list), zero-filled, so the
    // UI never has to guess why an option is missing from the response.
    const setAsideFacets = await tx<{ value: string; count: string }[]>`
      SELECT v.value, COALESCE(counts.count, 0) AS count
      FROM (VALUES ${sql(SET_ASIDE_VALUES.map((v) => [v]))}) AS v(value)
      LEFT JOIN (
        SELECT b AS value, COUNT(*)::bigint AS count
        FROM open_solicitations, unnest(badges) AS b
        WHERE ${fscCondition(sql, query.fsc)} AND ${postedCondition(sql, query.posted)} AND ${firstArticleCondition(sql, query.firstArticle)} AND ${buildFilterConditions(sql, { ...filters, setAside: undefined })}
          AND b = ANY(${SET_ASIDE_VALUES}::text[])
        GROUP BY b
      ) counts ON counts.value = v.value
      ORDER BY v.value
    `;

    return { fscFacets, setAsideFacets };
  });

  return NextResponse.json({
    facets: fscFacets.map((f) => ({ fsc: f.fsc, count: Number(f.count) })),
    setAside: setAsideFacets.map((f) => ({ value: f.value, count: Number(f.count) })),
  });
}
