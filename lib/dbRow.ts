// Maps a raw solicitations-table row (snake_case, as postgres.js returns it) back to the
// app's Solicitation shape (camelCase). Inverse of scripts/db/upsertSolicitations.ts's
// toDbRow(), kept here so API routes don't duplicate this mapping.

import type { Solicitation } from "./solicitation.ts";

// Matches whatever columns the SELECT lists in app/api/*/route.ts actually name -- callers
// must select every one of these, in any order (postgres.js returns objects, not tuples).
export interface SolicitationDbRow {
  nsn: string;
  nsn_raw: string;
  nsn_digits: string | null;
  nomenclature: string;
  technical_documents: string | null;
  solicitation_number: string;
  solicitation_number_raw: string;
  document_url: string | null;
  status: string | null;
  has_attachments: boolean;
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
  // Computed at query time (first_seen_at > now() - 24h), not a stored column -- a row's
  // "newness" changes on its own as time passes, independent of any re-ingest.
  is_new: boolean;
  // Both computed at query time from nsn_digits/nomenclature/solicitation_number_raw -- see
  // lib/apiQuery.ts's IS_FIRST_ARTICLE_SQL and app/api/solicitations/route.ts's EXISTS.
  is_first_article: boolean;
  has_first_article_sibling: boolean;
}

export interface ApiSolicitation extends Solicitation {
  isNew: boolean;
  isFirstArticle: boolean;
  hasFirstArticleSibling: boolean;
}

export function dbRowToSolicitation(row: SolicitationDbRow): ApiSolicitation {
  return {
    nsn: row.nsn,
    nsnRaw: row.nsn_raw,
    nsnDigits: row.nsn_digits,
    nomenclature: row.nomenclature,
    technicalDocuments: row.technical_documents as Solicitation["technicalDocuments"],
    solicitationNumber: row.solicitation_number,
    solicitationNumberRaw: row.solicitation_number_raw,
    documentUrl: row.document_url,
    status: row.status,
    hasAttachments: row.has_attachments,
    purchaseRequestNumber: row.purchase_request_number,
    quantity: row.quantity,
    issuedDate: row.issued_date,
    returnByDate: row.return_by_date,
    badges: row.badges as Solicitation["badges"],
    packageViewUrl: row.package_view_url,
    sourceDate: row.source_date,
    fetchedAt: row.fetched_at,
    fsc: row.fsc,
    solicitationType: row.solicitation_type as Solicitation["solicitationType"],
    isNew: row.is_new,
    isFirstArticle: row.is_first_article,
    hasFirstArticleSibling: row.has_first_article_sibling,
  };
}
