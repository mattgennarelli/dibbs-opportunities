// Pure HTML parsing for DIBBS's RfqRecs.aspx results grid. Shared by every fetcher
// (curl, Playwright, ...) so parsing logic never drifts between them.

import type { Badge, Solicitation } from "./solicitation.ts";

export interface Diagnostics {
  unexpectedTechDocsSamples: string[];
  badgeFilenames: Set<string>;
}

export function parseRecordsFound(html: string): number | null {
  const m = html.match(/lblRecCount">Records Found:\s*<strong>\s*([\d,]+)\s*<\/strong>/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

function parseIsoDate(mmddyyyy: string | undefined | null): string | null {
  if (!mmddyyyy) return null;
  const m = mmddyyyy.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

// DIBBS formats a real NSN as NNNN-NN-NNN-NNNN (13 digits with dashes). Some rows -- e.g.
// "First Article" line items -- show a reference number in that cell instead (seen live:
// "0001S00000053"), which is not an NSN and must not be treated as one.
const NSN_PATTERN = /^\d{4}-\d{2}-\d{3}-\d{4}$/;

function isRealNsn(nsn: string): boolean {
  return NSN_PATTERN.test(nsn);
}

function deriveFsc(nsnDigits: string): string {
  return nsnDigits.slice(0, 4);
}

function deriveSolicitationType(raw: string): Solicitation["solicitationType"] {
  if (raw.length < 9) return null;
  const ninth = raw[8].toUpperCase();
  if (ninth === "T" || ninth === "U") return "automated";
  if (ninth === "Q") return "buyerGenerated";
  return "other";
}

function badgeFromIconFilename(filename: string): Badge {
  const lower = filename.toLowerCase();
  if (lower.includes("fastpace")) return "fastAward";
  if (lower.includes("unrestrictednotsetaside")) return "unrestricted";
  if (/\bsb\b/i.test(filename) || lower.includes("setaside")) return "smallBusinessSetAside";
  return "other";
}

// Splits the grid's inner HTML into one chunk per data row using the lblRowNum anchor,
// which is the first span rendered in every row.
export function splitRows(gridHtml: string): string[] {
  const marker = /<span id="[^"]*_lblRowNum"/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(gridHtml))) starts.push(m.index);
  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : gridHtml.length;
    chunks.push(gridHtml.slice(starts[i], end));
  }
  return chunks;
}

export function parseRow(
  chunk: string,
  sourceDate: string,
  fetchedAt: string,
  diagnostics: Diagnostics,
  base: string
): Solicitation | null {
  // href is single-quoted in DIBBS's raw server HTML (curl fetcher) but re-serialized with
  // double quotes by a real browser's DOM (Playwright fetcher) -- match either. Some rows
  // (e.g. "First Article" line items) carry a plain reference number instead of a real NSN
  // and render it as bare text with no <a> link at all -- the link wrapper is optional, or
  // the row is silently dropped (found 2026-11-23: 32/34 rows parsed for 11-21-2026).
  const nsnMatch = chunk.match(/_lblNsn"[^>]*>(?:<a href=['"][^'"]+['"][^>]*>)?([^<]+)(?:<\/a>)?/);
  const nomMatch = chunk.match(/_lblNomenclature"[^>]*>([^<]*)</);
  const techDocsMatch = chunk.match(/_lblTechnicalDocuments"[^>]*>([\s\S]*?)<\/span>/);
  const solMatch = chunk.match(
    /_lblSolicitation"[^>]*><a href=['"]([^'"]+)['"][^>]*>([^<]+)<\/a>[\s\S]*?rfqrec\.aspx\?sn=([A-Za-z0-9]+)/
  );
  const statusMatch = chunk.match(/_lblStatus">(?:<span[^>]*>)?([^<]+)/);
  const prMatch = chunk.match(/_lblPr">([^<]*)<br\s*\/?>\s*QTY:\s*(\d+)/);
  const issuedMatch = chunk.match(/_lblIssued"[^>]*>([^<]*)</);
  const returnByMatch = chunk.match(/_lblReturnBy"[^>]*>([^<]*)</);

  if (!nsnMatch || !solMatch) return null;

  const nsn = nsnMatch[1].trim();
  const nsnRaw = nsn;
  const nsnDigits = isRealNsn(nsn) ? nsn.replace(/\D/g, "") : null;
  const solicitationNumber = solMatch[2].trim();
  const solicitationNumberRaw = solMatch[3].trim();
  const documentUrl = solMatch[1].trim();

  const techDocsRaw = (techDocsMatch?.[1] ?? "").trim();
  let technicalDocuments: Solicitation["technicalDocuments"];
  if (techDocsRaw === "None" || techDocsRaw === "" || techDocsRaw === "&nbsp;") {
    technicalDocuments = "none";
  } else {
    technicalDocuments = "present";
    if (diagnostics.unexpectedTechDocsSamples.length < 2) {
      diagnostics.unexpectedTechDocsSamples.push(techDocsMatch?.[0] ?? techDocsRaw);
    }
  }

  const badgeIconRe = /icons\/(icon[A-Za-z0-9]+)\.(?:gif|png)/g;
  const badges: Badge[] = [];
  let iconMatch: RegExpExecArray | null;
  while ((iconMatch = badgeIconRe.exec(chunk))) {
    const filename = iconMatch[1];
    diagnostics.badgeFilenames.add(filename);
    if (filename === "iconSpace1010") continue; // decorative spacer, not a real badge
    badges.push(badgeFromIconFilename(filename));
  }

  return {
    nsn,
    nsnRaw,
    nsnDigits,
    nomenclature: (nomMatch?.[1] ?? "").trim(),
    technicalDocuments,
    solicitationNumber,
    solicitationNumberRaw,
    documentUrl,
    status: (statusMatch?.[1] ?? "").trim(),
    purchaseRequestNumber: prMatch?.[1]?.trim() || null,
    quantity: prMatch ? Number(prMatch[2]) : null,
    issuedDate: parseIsoDate(issuedMatch?.[1]),
    returnByDate: parseIsoDate(returnByMatch?.[1]),
    badges,
    packageViewUrl: `${base}/rfq/rfqrec.aspx?sn=${solicitationNumberRaw}`,
    sourceDate,
    fetchedAt,
    fsc: nsnDigits !== null ? deriveFsc(nsnDigits) : null,
    solicitationType: deriveSolicitationType(solicitationNumberRaw),
  };
}

export function findGridHtml(html: string): string | null {
  const idx = html.indexOf('id="ctl00_cph1_grdRfqSearch"');
  if (idx === -1) return null;
  return html.slice(idx);
}

// Composite key identifying a row regardless of which fetcher produced it. Used to detect
// a pagination stall (same rows served again under a different page number).
export function rowKey(row: Solicitation): string {
  return `${row.solicitationNumberRaw}|${row.nsnDigits ?? row.nsnRaw}|${row.purchaseRequestNumber ?? ""}`;
}
