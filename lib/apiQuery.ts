// Shared query-building logic for /api/solicitations and /api/facets: request validation,
// cursor encoding, and the WHERE-condition builder every one of those routes' SQL queries
// reuses, so "what counts as matching the filters" can never drift between them.

import { z } from "zod";
import postgres from "postgres";

// z.coerce.boolean() treats ANY non-empty string -- including the literal string "false"
// -- as true, which would silently invert a caller's ?fastAward=false into "on." Each
// boolean query param is instead restricted to exactly these two tokens; anything else
// (including "True", "1", "yes") is a validation error, not a guess.
const strictBoolean = () => z.stringbool({ truthy: ["true"], falsy: ["false"] }).optional();

export const QuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    fsc: z.array(z.string().regex(/^\d{4}$/, "fsc must be a 4-digit code")).optional(),
    fastAward: strictBoolean(),
    smallBusiness: strictBoolean(),
    techDocs: strictBoolean(),
    minQty: z.coerce.number().int().nonnegative().optional(),
    closingWithinDays: z.coerce.number().int().nonnegative().optional(),
    sort: z.enum(["deadline", "quantity", "issued", "relevance"]).default("deadline"),
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
  return {
    q: searchParams.get("q") ?? undefined,
    fsc: fsc.length > 0 ? fsc : undefined,
    fastAward: searchParams.get("fastAward") ?? undefined,
    smallBusiness: searchParams.get("smallBusiness") ?? undefined,
    techDocs: searchParams.get("techDocs") ?? undefined,
    minQty: searchParams.get("minQty") ?? undefined,
    closingWithinDays: searchParams.get("closingWithinDays") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
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
  deadline: { column: "return_by_date", nullable: false },
  quantity: { column: "quantity", nullable: true },
  issued: { column: "issued_date", nullable: true },
} as const;
export type BrowseSortKey = keyof typeof BROWSE_SORT_SPECS;

export type BrowseCursor = { type: "browse"; sortKey: BrowseSortKey; v: string | number | null; id: number };
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

// ORDER BY for a given browse sort key. NULLS LAST is an explicit, documented choice (not
// Postgres's default for ASC, which is NULLS LAST too as it happens, but spelled out here
// so it doesn't depend on that default never changing): a solicitation missing a quantity
// or issued date shouldn't crowd the front of a "sort by quantity"/"sort by issued" list.
export function browseOrderBy(sql: postgres.Sql, sortKey: BrowseSortKey): postgres.Fragment {
  switch (sortKey) {
    case "deadline":
      return sql`return_by_date ASC, id ASC`;
    case "quantity":
      return sql`quantity ASC NULLS LAST, id ASC`;
    case "issued":
      return sql`issued_date ASC NULLS LAST, id ASC`;
  }
}

// Keyset predicate for resuming a browse-mode page. `cursor` is null on the first page
// (no predicate needed). For a nullable sort column, resuming from a non-null cursor value
// must also include every NULL row (NULLS LAST means they all sort after every real value,
// not just after ones greater than the cursor); resuming from a null cursor value means
// "already inside the NULL group," where only the id tie-break still applies.
export function browseKeysetCondition(sql: postgres.Sql, sortKey: BrowseSortKey, cursor: BrowseCursor | null): postgres.Fragment {
  if (!cursor) return sql`true`;
  switch (sortKey) {
    case "deadline":
      return sql`(return_by_date, id) > (${cursor.v}::date, ${cursor.id}::bigint)`;
    case "quantity":
      return cursor.v === null
        ? sql`quantity IS NULL AND id > ${cursor.id}::bigint`
        : sql`(quantity IS NULL OR (quantity, id) > (${cursor.v}::int, ${cursor.id}::bigint))`;
    case "issued":
      return cursor.v === null
        ? sql`issued_date IS NULL AND id > ${cursor.id}::bigint`
        : sql`(issued_date IS NULL OR (issued_date, id) > (${cursor.v}::date, ${cursor.id}::bigint))`;
  }
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
  smallBusiness?: boolean;
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
  if (f.smallBusiness) conditions.push(sql`badges @> ARRAY['smallBusinessSetAside']`);
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
