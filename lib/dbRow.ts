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
}

export function dbRowToSolicitation(row: SolicitationDbRow): Solicitation {
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
  };
}
