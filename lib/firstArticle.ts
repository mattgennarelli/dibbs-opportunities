// Pure sub-line assembly/display logic, kept DB- and React-free so it's directly
// unit-testable (see tests/firstArticle.test.ts) -- used by app/api/solicitations/route.ts
// (server-side assembly) and app/page.tsx (client-side label text). A "sub-line" is any
// non-NSN row that has a real-NSN sibling on its solicitation (First Article Test,
// Production Lot Testing, or any other non-catalog line item) -- see lib/apiQuery.ts's
// isSublineSql for the authoritative SQL-side definition this mirrors.

// Minimal shape withSublinesAssembled needs -- a structural subset of SolicitationDbRow /
// ApiSolicitation, so callers on either side of the API boundary can use their own row type
// without a cast.
export interface SublineRow {
  solicitation_number_raw: string;
}

// Interleaves a page's sub-lines into the final display list: each parent row immediately
// followed by every sub-line on its solicitation (if any -- each sub-line used at most once,
// so a second parent sharing the same solicitation_number_raw doesn't duplicate them). A
// sub-line is only ever fetched when its parent is genuinely on this page (see route.ts's
// query scoping), so every sub-line in `sublines` has a home here -- there's no "orphan"
// case to handle: a non-NSN row with no real-NSN sibling was never classified a sub-line in
// the first place, and flows through the main query as an ordinary standalone row instead.
export function withSublinesAssembled<T extends SublineRow>(parents: T[], sublines: T[]): T[] {
  const bySolicitation = new Map<string, T[]>();
  for (const line of sublines) {
    const list = bySolicitation.get(line.solicitation_number_raw) ?? [];
    list.push(line);
    bySolicitation.set(line.solicitation_number_raw, list);
  }
  const out: T[] = [];
  for (const parent of parents) {
    out.push(parent);
    const lines = bySolicitation.get(parent.solicitation_number_raw);
    if (lines && lines.length > 0) {
      out.push(...lines);
      bySolicitation.delete(parent.solicitation_number_raw); // used -- don't repeat under a second parent
    }
  }
  return out;
}

// "GOVERNMENT FIRST ARTIC" / "CONTRACTOR FIRST ARTIC" (DIBBS truncates both to the same
// width) -- which First Article Test variant this is, straight from the nomenclature text
// already in the row, no extra column needed. Empty string for neither (defensive: every
// live FA row seen so far is one of these two, but a third variant shouldn't crash the UI).
function firstArticleVariantLabel(nomenclature: string): string {
  const upper = nomenclature.toUpperCase();
  if (upper.includes("GOVERNMENT")) return "Government";
  if (upper.includes("CONTRACTOR")) return "Contractor";
  return "";
}

// Mirrors lib/apiQuery.ts's IS_LOT_TESTING_SQL exactly (that fragment imports this same
// constant) -- kept as one shared literal so the SQL pattern and this pure JS check can't
// silently drift apart. Deliberately does NOT match "PRODUCTION CONTROL TESTING", a
// distinct, unverified category (see lib/apiQuery.ts's IS_LOT_TESTING_SQL comment).
export const LOT_TESTING_SUBSTRING = "PRODUCTION LOT TEST";

// Pure mirror of IS_LOT_TESTING_SQL -- not used in the request path (the SQL fragment does
// the real check), but documents and pins the exact matching rule independent of a DB
// connection; see tests/firstArticle.test.ts.
export function isLotTestingNomenclature(nomenclature: string): boolean {
  return nomenclature.toUpperCase().includes(LOT_TESTING_SUBSTRING);
}

function sentenceCase(s: string): string {
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// The text shown on a sub-line row itself, always nested ("↳ ..." -- every true sub-line has
// a parent, by definition, so there's no standalone/orphan variant to label). First Article
// lines get their existing special-cased format; everything else (Production Lot Testing,
// or any other non-catalog line item) just gets its own nomenclature, sentence-cased.
export function sublineLabel(nomenclature: string, isFirstArticle: boolean): string {
  if (isFirstArticle) {
    const variant = firstArticleVariantLabel(nomenclature);
    return `↳ ${variant ? `First Article test (${variant})` : "First Article test"}`;
  }
  return `↳ ${sentenceCase(nomenclature)}`;
}
