// Shared data model for a single DIBBS RFQ row and one day's ingest result.
// Used by both scripts/ingest.ts (producer) and the app (consumer) so the two never drift.
// Every field here is either a real scraped column, or a derived field computed only from
// real columns (fsc, solicitationType) per the project's correctness rule: never invent values.

export type Badge = "fastAward" | "unrestricted" | "smallBusinessSetAside" | "other";

export interface Solicitation {
  nsn: string;
  nsnDigits: string;
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
  fsc: string;
  solicitationType: "automated" | "buyerGenerated" | "other" | null;
}

export interface IngestResult {
  date: string;
  recordsFound: number | null;
  rows: Solicitation[];
  fetchedAt: string;
  errors: string[];
}
