// Scrapes DLA DIBBS open-RFQ listings for one issue date into data/solicitations.json.
// Run: npm run ingest [-- MM-DD-YYYY] [--max-pages N] [--out data/sample.json]
//
// HTTP is done by shelling out to the system `curl` binary rather than Node's fetch.
// DIBBS sits behind a WAF that appears to TLS/bot-fingerprint the client: curl gets a normal
// response, Node's built-in fetch (undici) gets an immediate "Request Rejected" on every URL,
// including "/". Using curl avoids pulling in a new npm dependency (CLAUDE.md: ask before
// adding deps) while still working against the real site.

import { writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import type { Badge, Solicitation, IngestResult } from "../lib/solicitation.ts";

const execFileP = promisify(execFile);

const BASE = "https://www.dibbs.bsm.dla.mil";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_THROTTLE_MS = 300;
const COOKIE_JAR = path.join(os.tmpdir(), `dibbs-ingest-cookies-${process.pid}.txt`);

interface Diagnostics {
  unexpectedTechDocsSamples: string[];
  badgeFilenames: Set<string>;
}

interface CurlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Async execFile has no stdin-piping option (only the *Sync variants do), so a POST body
// is written to a scratch file and referenced with --data-binary @file instead of @-.
let bodyFileCounter = 0;

async function curlRequest(url: string, opts: { method?: "GET" | "POST"; body?: string } = {}): Promise<CurlResponse> {
  const args = ["-sS", "-D", "-", "-o", "-", "-A", UA, "-b", COOKIE_JAR, "-c", COOKIE_JAR];
  let bodyFile: string | null = null;
  if (opts.method === "POST") {
    bodyFile = path.join(os.tmpdir(), `dibbs-ingest-body-${process.pid}-${bodyFileCounter++}.txt`);
    await writeFile(bodyFile, opts.body ?? "");
    args.push("-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data-binary", `@${bodyFile}`);
  }
  args.push(url);

  let stdout: Buffer;
  try {
    const res = await execFileP("curl", args, {
      maxBuffer: 1024 * 1024 * 50,
      encoding: "buffer",
    });
    stdout = res.stdout as unknown as Buffer;
  } finally {
    if (bodyFile) await rm(bodyFile, { force: true });
  }
  const buf = stdout;
  const sep = buf.indexOf("\r\n\r\n");
  if (sep === -1) throw new Error(`curl response for ${url} had no header/body separator`);
  const headerPart = buf.subarray(0, sep).toString("utf-8");
  const bodyPart = buf.subarray(sep + 4).toString("utf-8");

  const lines = headerPart.split("\r\n");
  const statusLine = lines[0] ?? "";
  const status = Number(statusLine.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers, body: bodyPart };
}

function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /name="([^"]+)"[^>]*value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    fields[m[1]] = m[2];
  }
  return fields;
}

// The edge WAF rejects direct hits to deep URLs from a cookieless client ("Request Rejected"),
// so a session must be warmed up by visiting the homepage first, which is what actually
// triggers the DOD-warning consent redirect. Must run once before any other request.
async function establishSession(): Promise<void> {
  const res = await curlRequest(`${BASE}/`, { method: "GET" });

  if ((res.status === 302 || res.status === 301) && res.headers.location?.includes("dodwarning.aspx")) {
    const warningUrl = new URL(res.headers.location, BASE).toString();
    const warningPage = await curlRequest(warningUrl, { method: "GET" });
    const fields = extractHiddenFields(warningPage.body);
    if (!("butAgree" in fields)) {
      throw new Error(`Consent page at ${warningUrl} did not contain expected butAgree field`);
    }
    const body = new URLSearchParams(fields).toString();
    const postRes = await curlRequest(warningUrl, { method: "POST", body });
    if (postRes.status !== 302) {
      throw new Error(`Consent POST to ${warningUrl} returned unexpected status ${postRes.status}`);
    }
    return;
  }

  if (res.status !== 200) {
    throw new Error(
      `Unexpected status ${res.status} warming up session at ${BASE}/ (body starts: ${res.body.slice(0, 200)})`
    );
  }
  // status 200 with no consent redirect means this session already had a valid "dw" cookie,
  // or the WAF let it straight through.
}

// Returns page HTML for `url`, assuming establishSession() already ran for this process.
async function getPage(url: string): Promise<string> {
  const res = await curlRequest(url, { method: "GET" });

  if (res.status === 302 || res.status === 301) {
    if (res.headers.location?.includes("dodwarning.aspx")) {
      throw new Error(`Redirected to consent page fetching ${url} even after establishSession()`);
    }
    throw new Error(`Unexpected redirect fetching ${url} -> ${res.headers.location}`);
  }
  if (res.status !== 200) {
    throw new Error(`Unexpected status ${res.status} fetching ${url} (body starts: ${res.body.slice(0, 200)})`);
  }
  return res.body;
}

function isRejectedOrWarningPage(html: string): boolean {
  return html.includes("Request Rejected") || (html.includes('id="FrmBody"') && html.includes("butAgree"));
}

function parseRecordsFound(html: string): number | null {
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
function splitRows(gridHtml: string): string[] {
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

function parseRow(chunk: string, sourceDate: string, fetchedAt: string, diagnostics: Diagnostics): Solicitation | null {
  const nsnMatch = chunk.match(/_lblNsn"[^>]*><a href='([^']+)'[^>]*>([^<]+)<\/a>/);
  const nomMatch = chunk.match(/_lblNomenclature"[^>]*>([^<]*)</);
  const techDocsMatch = chunk.match(/_lblTechnicalDocuments"[^>]*>([\s\S]*?)<\/span>/);
  const solMatch = chunk.match(
    /_lblSolicitation"[^>]*><a href='([^']+)'[^>]*>([^<]+)<\/a>[\s\S]*?rfqrec\.aspx\?sn=([A-Za-z0-9]+)/
  );
  const statusMatch = chunk.match(/_lblStatus">(?:<span[^>]*>)?([^<]+)/);
  const prMatch = chunk.match(/_lblPr">([^<]*)<br\s*\/?>\s*QTY:\s*(\d+)/);
  const issuedMatch = chunk.match(/_lblIssued"[^>]*>([^<]*)</);
  const returnByMatch = chunk.match(/_lblReturnBy"[^>]*>([^<]*)</);

  if (!nsnMatch || !solMatch) return null;

  const nsn = nsnMatch[2].trim();
  const nsnDigits = nsn.replace(/\D/g, "");
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
    packageViewUrl: `${BASE}/rfq/rfqrec.aspx?sn=${solicitationNumberRaw}`,
    sourceDate,
    fetchedAt,
    fsc: deriveFsc(nsnDigits),
    solicitationType: deriveSolicitationType(solicitationNumberRaw),
  };
}

function findGridHtml(html: string): string | null {
  const idx = html.indexOf('id="ctl00_cph1_grdRfqSearch"');
  if (idx === -1) return null;
  return html.slice(idx);
}

async function ingestDate(date: string, maxPages: number | null): Promise<IngestResult> {
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  const diagnostics: Diagnostics = { unexpectedTechDocsSamples: [], badgeFilenames: new Set() };
  const rows: Solicitation[] = [];

  const dayUrl = `${BASE}/RFQ/RfqRecs.aspx?category=issue&TypeSrch=dt&Value=${date}`;
  let html = await getPage(dayUrl);

  if (isRejectedOrWarningPage(html)) {
    throw new Error("Received the WAF/consent page instead of the results grid on page 1");
  }
  let gridHtml = findGridHtml(html);
  if (!gridHtml) {
    throw new Error(`Grid element (#ctl00_cph1_grdRfqSearch) not found on page 1 for ${date}`);
  }

  const recordsFound = parseRecordsFound(html);
  console.log(`[ingest] ${date}: Records Found = ${recordsFound ?? "unknown"}`);

  let pageNum = 1;
  let hiddenFields = extractHiddenFields(html);
  const pageSize = 50;
  const totalPages = recordsFound !== null ? Math.ceil(recordsFound / pageSize) : null;

  while (true) {
    const rowsBefore = rows.length;
    for (const chunk of splitRows(gridHtml)) {
      const row = parseRow(chunk, date, fetchedAt, diagnostics);
      if (row) rows.push(row);
    }
    console.log(
      `[ingest] ${date}: page ${pageNum}${totalPages ? `/${totalPages}` : ""} parsed, ${rows.length} rows so far`
    );

    if (rows.length === rowsBefore) {
      errors.push(`Page ${pageNum} added no new rows; stopping (recordsFound=${recordsFound ?? "unknown"}).`);
      break;
    }

    if (recordsFound !== null && rows.length >= recordsFound) break;

    if (maxPages !== null && pageNum >= maxPages) {
      errors.push(`Stopped after --max-pages ${maxPages} (sample run; ${rows.length}/${recordsFound ?? "unknown"} rows fetched).`);
      break;
    }

    const nextPageNum = pageNum + 1;
    await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));

    const postBody = new URLSearchParams({
      ...hiddenFields,
      __EVENTTARGET: "ctl00$cph1$grdRfqSearch",
      __EVENTARGUMENT: `Page$${nextPageNum}`,
    }).toString();

    let pageRes: CurlResponse;
    try {
      pageRes = await curlRequest(dayUrl, { method: "POST", body: postBody });
    } catch (err) {
      errors.push(
        `Page ${nextPageNum} request failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Stopped with ${rows.length}/${recordsFound ?? "unknown"} rows.`
      );
      break;
    }

    if (pageRes.status !== 200) {
      errors.push(`Page ${nextPageNum} returned status ${pageRes.status}. Stopped with ${rows.length} rows.`);
      break;
    }
    if (isRejectedOrWarningPage(pageRes.body)) {
      errors.push(`Page ${nextPageNum} returned the WAF/consent page (session dropped mid-run). Stopped with ${rows.length} rows.`);
      break;
    }
    const nextGrid = findGridHtml(pageRes.body);
    if (!nextGrid) {
      errors.push(`Page ${nextPageNum} response did not contain the results grid. Stopped with ${rows.length} rows.`);
      break;
    }

    html = pageRes.body;
    gridHtml = nextGrid;
    hiddenFields = extractHiddenFields(html);
    pageNum = nextPageNum;

    if (pageNum > 500) {
      errors.push(`Aborted after ${pageNum} pages as a safety stop (recordsFound=${recordsFound}).`);
      break;
    }
  }

  if (maxPages === null && recordsFound !== null && rows.length !== recordsFound) {
    errors.push(`Row count mismatch: parsed ${rows.length} rows but site reported Records Found: ${recordsFound}.`);
  }

  if (diagnostics.unexpectedTechDocsSamples.length > 0) {
    console.log("[ingest] Unexpected technicalDocuments cell content (raw HTML, up to 2 samples):");
    for (const sample of diagnostics.unexpectedTechDocsSamples) console.log("  " + sample);
  } else {
    console.log("[ingest] No technicalDocuments cells seen other than None/blank on this run.");
  }
  console.log("[ingest] Distinct badge icon filenames seen:", [...diagnostics.badgeFilenames].join(", ") || "(none)");

  return { date, recordsFound, rows, fetchedAt, errors };
}

async function getLatestIssueDate(): Promise<string> {
  const html = await getPage(`${BASE}/Rfq/RfqDates.aspx?category=issue`);
  if (isRejectedOrWarningPage(html)) {
    throw new Error("Received the WAF/consent page instead of RfqDates.aspx");
  }
  const m = html.match(/Value=(\d{2}-\d{2}-\d{4})'[^>]*title='Link to RFQ data'/);
  if (!m) throw new Error("Could not find any issue date link on RfqDates.aspx");
  return m[1];
}

interface CliArgs {
  date: string | null;
  maxPages: number | null;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | null = null;
  let maxPages: number | null = null;
  let out = "data/solicitations.json";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--max-pages") {
      const val = argv[++i];
      maxPages = Number(val);
      if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error(`--max-pages expects a positive integer, got "${val}"`);
      }
    } else if (arg === "--out") {
      out = argv[++i];
      if (!out) throw new Error("--out expects a file path");
    } else if (/^\d{2}-\d{2}-\d{4}$/.test(arg)) {
      date = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { date, maxPages, out };
}

async function main() {
  const { date: cliDate, maxPages, out } = parseArgs(process.argv.slice(2));

  await establishSession();
  const date = cliDate ?? (await getLatestIssueDate());

  if (cliDate) {
    console.log(`[ingest] Using CLI-provided date: ${date}`);
  } else {
    console.log(`[ingest] Latest issue date from RfqDates.aspx: ${date}`);
  }
  if (maxPages !== null) {
    console.log(`[ingest] --max-pages ${maxPages}: this will be a partial sample run, not a full day's data.`);
  }

  const outPath = path.resolve(process.cwd(), out);
  await mkdir(path.dirname(outPath), { recursive: true });

  let result: IngestResult;
  try {
    result = await ingestDate(date, maxPages);
  } catch (err) {
    result = {
      date,
      recordsFound: null,
      rows: [],
      fetchedAt: new Date().toISOString(),
      errors: [`Ingest failed before any rows were parsed: ${err instanceof Error ? err.message : String(err)}`],
    };
    await writeFile(outPath, JSON.stringify(result, null, 2));
    console.error("[ingest] FAILED:", result.errors[0]);
    process.exitCode = 1;
    return;
  }

  await writeFile(outPath, JSON.stringify(result, null, 2));

  console.log("\n[ingest] Summary");
  console.log(`  date: ${result.date}`);
  console.log(`  recordsFound: ${result.recordsFound}`);
  console.log(`  rowsParsed: ${result.rows.length}`);
  console.log(`  errors: ${result.errors.length ? result.errors.join(" | ") : "none"}`);
  console.log(`  wrote: ${outPath}`);

  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[ingest] Unhandled error:", err);
  process.exitCode = 1;
});
