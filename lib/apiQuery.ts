// Shared query-building logic for /api/solicitations and /api/facets: request validation,
// cursor encoding, and the WHERE-condition builder every one of those routes' SQL queries
// reuses, so "what counts as matching the filters" can never drift between them.

import { z } from "zod";
import postgres from "postgres";
import { LOT_TESTING_SUBSTRING } from "./firstArticle.ts";

// z.coerce.boolean() treats ANY non-empty string -- including the literal string "false"
// -- as true, which would silently invert a caller's ?fastAward=false into "on." Each
// boolean query param is instead restricted to exactly these two tokens; anything else
// (including "True", "1", "yes") is a validation error, not a guess.
const strictBoolean = () => z.stringbool({ truthy: ["true"], falsy: ["false"] }).optional();

// The six set-aside/unrestricted badge values a row can be filtered by. Deliberately not
// "fastAward" or "other" -- those aren't set-aside programs, so they're not part of this
// filter's vocabulary even though they're also Badge values.
export const SET_ASIDE_VALUES = ["smallBusinessSetAside", "hubZone", "eightA", "sdvosb", "wosb", "unrestricted"] as const;
export type SetAsideValue = (typeof SET_ASIDE_VALUES)[number];

export const QuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    fsc: z.array(z.string().regex(/^\d{4}$/, "fsc must be a 4-digit code")).optional(),
    fastAward: strictBoolean(),
    // Rows match ANY selected value (OR, not AND) -- see buildFilterConditions's `&&` below.
    setAside: z.array(z.enum(SET_ASIDE_VALUES)).optional(),
    techDocs: strictBoolean(),
    minQty: z.coerce.number().int().nonnegative().optional(),
    closingWithinDays: z.coerce.number().int().nonnegative().optional(),
    // How recently a row's source_date must be, relative to MAX(source_date) across the
    // whole table -- not wall-clock "today," so this stays meaningful even if ingest has
    // fallen behind. "latest" = just the single most recent posting date.
    posted: z.enum(["latest", "3d", "7d", "all"]).default("latest"),
    // First Article Test line items (non-NSN rows for the testing step of a solicitation
    // that already has a real-NSN line) -- lets a vendor hide the noise or isolate them.
    firstArticle: z.enum(["include", "exclude", "only"]).default("include"),
    sort: z.enum(["deadline", "quantity", "issued", "fsc", "nsn", "relevance"]).default("deadline"),
    // Ignored in sort=relevance (match-quality order has no "direction"); applies to every
    // browse-mode sort key.
    dir: z.enum(["asc", "desc"]).default("asc"),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .refine((v) => v.sort !== "relevance" || v.q !== undefined, {
    message: "sort=relevance requires q",
    path: ["sort"],
  });

export type Query = z.infer<typeof QuerySchema>;

// Builds the raw object zod validates from a real URLSearchParams. Done by hand rather than
// Object.fromEntries(searchParams) for two reasons: (1) Object.fromEntries silently keeps
// only the LAST value of a repeated key, dropping every fsc but one; (2) URLSearchParams.get
// returns null for an absent key, which zod's .optional() doesn't accept -- undefined does.
export function rawQueryFromSearchParams(searchParams: URLSearchParams): Record<string, unknown> {
  const fsc = searchParams.getAll("fsc");
  const setAside = searchParams.getAll("setAside");
  return {
    q: searchParams.get("q") ?? undefined,
    fsc: fsc.length > 0 ? fsc : undefined,
    fastAward: searchParams.get("fastAward") ?? undefined,
    setAside: setAside.length > 0 ? setAside : undefined,
    techDocs: searchParams.get("techDocs") ?? undefined,
    minQty: searchParams.get("minQty") ?? undefined,
    closingWithinDays: searchParams.get("closingWithinDays") ?? undefined,
    posted: searchParams.get("posted") ?? undefined,
    firstArticle: searchParams.get("firstArticle") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    dir: searchParams.get("dir") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  };
}

// True for a query that looks like someone typed/pasted an NSN (digits and dashes only,
// with at least one digit) -- "5330-01" or "533001" -- as opposed to free text like "gasket".
export function isNsnLooking(q: string): boolean {
  return /^[0-9-]+$/.test(q) && /\d/.test(q);
}

// Every browse-mode sort key, and which real column + NULL behavior it corresponds to.
// quantity/issued_date CAN be NULL within open_solicitations (unlike return_by_date, which
// the view's own WHERE already excludes NULLs for -- see db/migrations/001_init.sql);
// `nullable: true` here is what tells the keyset/order-by builders below to handle that.
export const BROWSE_SORT_SPECS = {
  deadline: { column: "return_by_date", nullable: false, cast: "date" },
  quantity: { column: "quantity", nullable: true, cast: "int" },
  issued: { column: "issued_date", nullable: true, cast: "date" },
  fsc: { column: "fsc", nullable: true, cast: "text" },
  nsn: { column: "nsn_digits", nullable: true, cast: "text" },
} as const;
export type BrowseSortKey = keyof typeof BROWSE_SORT_SPECS;
export type SortDir = "asc" | "desc";

export type BrowseCursor = { type: "browse"; sortKey: BrowseSortKey; dir: SortDir; v: string | number | null; id: number };
export type SearchCursor = { type: "search"; offset: number };

export function encodeCursor(cursor: BrowseCursor | SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

// Returns null for a malformed cursor rather than throwing -- the route decides that's a
// 400, this function just reports "this didn't decode," not why the caller should be told.
export function decodeCursor(raw: string): BrowseCursor | SearchCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (
      parsed?.type === "browse" &&
      parsed.sortKey in BROWSE_SORT_SPECS &&
      (parsed.dir === "asc" || parsed.dir === "desc") &&
      (typeof parsed.v === "string" || typeof parsed.v === "number" || parsed.v === null) &&
      typeof parsed.id === "number"
    ) {
      return parsed as BrowseCursor;
    }
    if (parsed?.type === "search" && typeof parsed.offset === "number") {
      return parsed as SearchCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ORDER BY for a given browse sort key + direction. NULLS LAST regardless of direction is an
// explicit, documented choice: a solicitation missing a quantity/issued/FSC/NSN value should
// stay anchored at the end of the list rather than jumping to the front when the column
// header's direction is toggled. DESC needs no separate index -- Postgres reads a btree
// index backward natively, so the same (column, id) index serves both directions.
export function browseOrderBy(sql: postgres.Sql, sortKey: BrowseSortKey, dir: SortDir): postgres.Fragment {
  const column = BROWSE_SORT_SPECS[sortKey].column;
  if (dir === "desc") {
    return sql`${sql.unsafe(column)} DESC NULLS LAST, id DESC`;
  }
  return sql`${sql.unsafe(column)} ASC NULLS LAST, id ASC`;
}

// Keyset predicate for resuming a browse-mode page. `cursor` is null on the first page (no
// predicate needed). NULLS LAST means a null-valued row sorts after every real value in
// EITHER direction, so: resuming from a non-null cursor must also include every NULL row
// (not just ones that compare past the cursor); resuming from a null cursor value means
// "already inside the NULL group," where only the id tie-break (direction-sensitive) applies.
export function browseKeysetCondition(sql: postgres.Sql, sortKey: BrowseSortKey, cursor: BrowseCursor | null): postgres.Fragment {
  if (!cursor) return sql`true`;
  const spec = BROWSE_SORT_SPECS[sortKey];
  const column = sql.unsafe(spec.column);
  const idOp = cursor.dir === "desc" ? sql`<` : sql`>`;
  if (!spec.nullable) {
    const tupleOp = cursor.dir === "desc" ? sql`<` : sql`>`;
    return sql`(${column}, id) ${tupleOp} (${cursor.v}::${sql.unsafe(spec.cast)}, ${cursor.id}::bigint)`;
  }
  if (cursor.v === null) {
    return sql`${column} IS NULL AND id ${idOp} ${cursor.id}::bigint`;
  }
  const tupleOp = cursor.dir === "desc" ? sql`<` : sql`>`;
  return sql`(${column} IS NULL OR (${column}, id) ${tupleOp} (${cursor.v}::${sql.unsafe(spec.cast)}, ${cursor.id}::bigint))`;
}

// Fragments are combined by nesting one sql`` template inside another (postgres.js supports
// this directly) rather than string concatenation, so every value stays a real bound
// parameter even when conditions are assembled dynamically.
function joinWithAnd(sql: postgres.Sql, conditions: postgres.Fragment[]): postgres.Fragment {
  if (conditions.length === 0) return sql`true`;
  return conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
}

export interface Filters {
  q?: string;
  fastAward?: boolean;
  // Rows match ANY of these (OR semantics -- the array-overlap `&&` operator below), not
  // all of them -- a row tagged just "hubZone" still matches a filter for
  // ["hubZone", "wosb"].
  setAside?: SetAsideValue[];
  techDocs?: boolean;
  minQty?: number;
  closingWithinDays?: number;
}

// Every filter EXCEPT fsc -- fsc is kept separate (see fscCondition below) because
// /api/facets needs exactly this set without fsc, and keeping it structurally apart makes
// that a one-line omission in the caller rather than a parameter to remember to pass.
//
// The q condition here is index-usable (`<%`, not a plain function call in WHERE) --
// callers MUST run it inside a transaction that has first done
// `SET LOCAL pg_trgm.word_similarity_threshold = ...` (see solicitationsRowsQuery below),
// or this falls back to the GUC's default threshold (0.6), which is far stricter than
// intended and would silently under-match.
export function buildFilterConditions(sql: postgres.Sql, f: Filters): postgres.Fragment {
  const conditions: postgres.Fragment[] = [];
  if (f.fastAward) conditions.push(sql`badges @> ARRAY['fastAward']`);
  if (f.setAside && f.setAside.length > 0) conditions.push(sql`badges && ${f.setAside}::text[]`);
  if (f.techDocs) conditions.push(sql`technical_documents = 'present'`);
  if (f.minQty !== undefined) conditions.push(sql`quantity >= ${f.minQty}::int`);
  if (f.closingWithinDays !== undefined) {
    conditions.push(sql`return_by_date <= (now() AT TIME ZONE 'America/New_York')::date + ${f.closingWithinDays}::int`);
  }
  if (f.q !== undefined) {
    if (isNsnLooking(f.q)) {
      // nsn_digits has a text_pattern_ops index (migration 003) specifically so this
      // LIKE-prefix form can use an index scan instead of a sequential scan.
      conditions.push(sql`nsn_digits LIKE ${f.q.replace(/-/g, "")}::text || '%'`);
    } else {
      // Operator form (not word_similarity(...) > threshold) is what lets the planner use
      // the GIN trigram index on nomenclature; the actual similarity score for ranking is
      // computed separately, only in ORDER BY (see solicitationsRowsQuery).
      conditions.push(sql`${f.q}::text <% nomenclature`);
    }
  }
  return joinWithAnd(sql, conditions);
}

export function fscCondition(sql: postgres.Sql, fsc?: string[]) {
  return fsc && fsc.length > 0 ? sql`fsc = ANY(${fsc}::text[])` : sql`true`;
}

export type PostedValue = "latest" | "3d" | "7d" | "all";

// "latest"/"3d"/"7d" are relative to MAX(source_date) in the WHOLE solicitations table, not
// wall-clock "today" -- if ingest hasn't run in a while, "latest" should still mean "the most
// recent day we actually have," not silently return nothing because today > any source_date.
export function postedCondition(sql: postgres.Sql, posted: PostedValue): postgres.Fragment {
  if (posted === "all") return sql`true`;
  const daysBack = posted === "latest" ? 0 : posted === "3d" ? 2 : 6;
  return sql`source_date >= (SELECT MAX(source_date) FROM solicitations) - ${daysBack}::int`;
}

export type FirstArticleValue = "include" | "exclude" | "only";

// A "sub-line": any row whose nsn is not a real 13-digit NSN AND whose solicitation has at
// least one real-NSN row elsewhere. Generalizes what used to be "First Article Test (FA)
// row" handling -- a solicitation can carry several different kinds of non-NSN line items
// (First Article Test, Production Lot Testing, raw-stock material, ...), and ALL of them
// need to travel with their real-NSN parent rather than compete with ordinary rows for
// search/filters/sort/pagination. A non-NSN row with NO real-NSN sibling is NOT a sub-line
// -- it's the only line item on its solicitation, so it stays an ordinary standalone row,
// fully subject to filters/search like any other row (see parentRowCondition below).
export function hasRealNsnSiblingSql(sql: postgres.Sql): postgres.Fragment {
  return sql`EXISTS (
    SELECT 1 FROM open_solicitations real_check
    WHERE real_check.solicitation_number_raw = open_solicitations.solicitation_number_raw
      AND real_check.nsn_digits IS NOT NULL
  )`;
}

export function isSublineSql(sql: postgres.Sql): postgres.Fragment {
  return sql`(nsn_digits IS NULL AND ${hasRealNsnSiblingSql(sql)})`;
}

// The main rows/count/facets query is restricted to this, always, regardless of
// `firstArticle` mode: a sub-line never matches filters, search, sort, or pagination on its
// own (it's fetched separately, per page, and nested under its parent). This is the one
// condition that keeps totals and facet counts "parent/normal rows only." A standalone
// non-NSN row (no real-NSN sibling) passes this and flows through the main query like any
// other row -- see the module comment above.
export function parentRowCondition(sql: postgres.Sql): postgres.Fragment {
  return sql`NOT ${isSublineSql(sql)}`;
}

// A First Article Test (FA) line item specifically: a non-NSN row whose nomenclature marks
// it as the testing step for a real-NSN line elsewhere in the same solicitation -- either
// the "GOVERNMENT FIRST ARTIC[LE TEST]" or "CONTRACTOR FIRST ARTIC[LE TEST]" variant (both
// truncated at the same width by DIBBS; confirmed live on SPE7L7-27-Q-0302, which has a
// CONTRACTOR line). `%FIRST ART%` catches both without over-matching: queried every other
// non-NSN nomenclature in the table (2026-11-23) and the only ones containing "FIRST ART"
// are these two. This is narrower than isSublineSql -- it drives the "First Article" PARENT
// flag specifically, not which rows get nested (that's isSublineSql, for every sub-line kind).
export const IS_FIRST_ARTICLE_SQL = (sql: postgres.Sql) =>
  sql`(nsn_digits IS NULL AND nomenclature LIKE '%FIRST ART%')`;

// A Production Lot Testing line item: DLAD 46.291 -- a quality test of the production lot
// before acceptance, priced as its own CLIN, following First Article approval when FAT
// applies. Deliberately NOT matching "PRODUCTION CONTROL TESTING" -- queried live and
// confirmed it's a distinct, unverified category (what it actually represents hasn't been
// confirmed), so it stays a nested sub-line only, with no flag. `LOT_TESTING_SUBSTRING` is
// shared with lib/firstArticle.ts's isLotTestingNomenclature so the SQL pattern and its pure
// JS mirror (used in tests) can't silently drift apart.
export const IS_LOT_TESTING_SQL = (sql: postgres.Sql) =>
  sql`(nsn_digits IS NULL AND nomenclature LIKE ${"%" + LOT_TESTING_SUBSTRING + "%"})`;

// Every query that touches these EXISTS fragments operates on `open_solicitations`
// unaliased -- they rely on that: the bare column names inside each subquery (via
// IS_FIRST_ARTICLE_SQL / IS_LOT_TESTING_SQL) resolve to the subquery's OWN aliased copy of
// the table (innermost scope wins in SQL), while `open_solicitations.solicitation_number_raw`
// explicitly reaches the outer row being evaluated. If a caller ever needs to run one of
// these against an aliased copy of the table, these must be revisited.

// EXISTS an FA line item anywhere on this row's solicitation. Deliberately self-inclusive:
// an FA row's own existence satisfies this for ITSELF too -- a standalone FA-text row with
// no real-NSN sibling (not a sub-line, just an ordinary row) still matches firstArticle=only
// on its own merit.
export function hasFirstArticleLineSql(sql: postgres.Sql): postgres.Fragment {
  return sql`EXISTS (
    SELECT 1 FROM open_solicitations fa_check
    WHERE fa_check.solicitation_number_raw = open_solicitations.solicitation_number_raw
      AND ${IS_FIRST_ARTICLE_SQL(sql)}
  )`;
}

// EXISTS a Production Lot Testing line item anywhere on this row's solicitation. Same
// self-inclusive shape as hasFirstArticleLineSql, for the same reason. Drives the "Lot
// Testing" parent flag only -- there's no lotTesting filter param (not asked for).
export function hasLotTestingLineSql(sql: postgres.Sql): postgres.Fragment {
  return sql`EXISTS (
    SELECT 1 FROM open_solicitations lot_check
    WHERE lot_check.solicitation_number_raw = open_solicitations.solicitation_number_raw
      AND ${IS_LOT_TESTING_SQL(sql)}
  )`;
}

// Solicitation-level filter: does this solicitation have an FA line at all? Applied ON TOP
// of parentRowCondition in the main query.
export function firstArticleCondition(sql: postgres.Sql, mode: FirstArticleValue): postgres.Fragment {
  if (mode === "include") return sql`true`;
  const hasFaLine = hasFirstArticleLineSql(sql);
  return mode === "exclude" ? sql`NOT ${hasFaLine}` : hasFaLine;
}
