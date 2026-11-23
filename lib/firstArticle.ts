// Pure First Article (FA) assembly/display logic, kept DB- and React-free so it's directly
// unit-testable (see tests/firstArticle.test.ts) -- used by app/api/solicitations/route.ts
// (server-side assembly) and app/page.tsx (client-side label text).

// Minimal shape these functions need -- a structural subset of SolicitationDbRow /
// ApiSolicitation, so callers on either side of the API boundary can use their own row type
// without a cast.
export interface FirstArticleRow {
  solicitation_number_raw: string;
  has_first_article_sibling: boolean;
}

// Interleaves a page's FA children and any orphans into the final display list: each parent
// row immediately followed by its own FA children (if it has any -- each child used at most
// once, so a second parent sharing the same solicitation_number_raw doesn't duplicate them),
// then every orphan appended at the end, unattached to any parent.
export function withFirstArticlesAssembled<T extends FirstArticleRow>(parents: T[], children: T[], orphans: T[]): T[] {
  const childrenBySolicitation = new Map<string, T[]>();
  for (const child of children) {
    const list = childrenBySolicitation.get(child.solicitation_number_raw) ?? [];
    list.push(child);
    childrenBySolicitation.set(child.solicitation_number_raw, list);
  }
  const out: T[] = [];
  for (const parent of parents) {
    out.push(parent);
    if (!parent.has_first_article_sibling) continue;
    const kids = childrenBySolicitation.get(parent.solicitation_number_raw);
    if (kids && kids.length > 0) {
      out.push(...kids);
      childrenBySolicitation.delete(parent.solicitation_number_raw); // used -- don't repeat under a second parent
    }
  }
  out.push(...orphans);
  return out;
}

// "GOVERNMENT FIRST ARTIC" / "CONTRACTOR FIRST ARTIC" (DIBBS truncates both to the same
// width) -- label an FA line by which variant it is, straight from the nomenclature text
// already in the row, no extra column needed. Empty string for neither (defensive: every
// live FA row seen so far is one of these two, but a third variant shouldn't crash the UI).
export function firstArticleVariantLabel(nomenclature: string): string {
  const upper = nomenclature.toUpperCase();
  if (upper.includes("GOVERNMENT")) return "Government";
  if (upper.includes("CONTRACTOR")) return "Contractor";
  return "";
}

// The text shown on an FA row itself: nested under its parent ("↳ ...") or, for a true
// orphan (no parent anywhere), standalone with an explanatory suffix.
export function firstArticleRowLabel(nomenclature: string, isOrphan: boolean): string {
  const variant = firstArticleVariantLabel(nomenclature);
  const label = variant ? `First Article test (${variant})` : "First Article test";
  return isOrphan ? `${label} — parent item not listed` : `↳ ${label}`;
}
