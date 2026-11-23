// Shared data model for a single DIBBS RFQ row and one day's ingest result.
// Used by both scripts/ingest.ts (producer) and the app (consumer) so the two never drift.
// Every field here is either a real scraped column, or a derived field computed only from
// real columns (fsc, solicitationType) per the project's correctness rule: never invent values.

export type Badge = "fastAward" | "unrestricted" | "smallBusinessSetAside" | "other";

export interface Solicitation {
  nsn: string;
  // Raw text of the NSN/reference-number cell, always present. Some rows (e.g. "First
  // Article" line items) show a reference number instead of a real 13-digit NSN -- for
  // those, nsnDigits and fsc are null rather than derived from a value that isn't an NSN.
  nsnRaw: string;
  nsnDigits: string | null;
  nomenclature: string;
  technicalDocuments: "none" | "present" | null;
  solicitationNumber: string;
  solicitationNumberRaw: string;
  documentUrl: string | null;
  status: string;
  purchaseRequestNumber: string | null;
  quantity: number | null;
  issuedDate: string | null;
  returnByDate: string | null;
  badges: Badge[];
  packageViewUrl: string;
  sourceDate: string;
  fetchedAt: string;
  fsc: string | null;
  solicitationType: "automated" | "buyerGenerated" | "other" | null;
}

export interface IngestResult {
  date: string;
  // Records Found as reported at the start of the run.
  recordsFound: number | null;
  // Records Found as reported after the last page fetched. DIBBS is a live site --
  // solicitations can close/post mid-run -- so this can differ from recordsFound; when it
  // does, errors[] records the exact before/after values rather than silently picking one.
  recordsFoundEnd: number | null;
  rows: Solicitation[];
  fetchedAt: string;
  errors: string[];
  // "partial" whenever unique rows < recordsFound, so a short run is never mistaken for a
  // complete one just because it exited without throwing. The next nightly ingest's upsert
  // is expected to catch any stragglers.
  status: "complete" | "partial";
}
