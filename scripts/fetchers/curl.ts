// Fetches DLA DIBBS open-RFQ listings for one issue date via raw curl + ASP.NET postback
// replay. Kept as a fallback fetcher (see scripts/fetchers/playwright.ts for the default) --
// bisection (2026-11-23) proved its Page$N postback silently stalls on page 1 regardless of
// HTTP headers, cookies, or body field order, and no fix was found at the HTTP level.
//
// HTTP is done by shelling out to the system `curl` binary rather than Node's fetch.
// DIBBS sits behind a WAF that appears to TLS/bot-fingerprint the client: curl gets a normal
// response, Node's built-in fetch (undici) gets an immediate "Request Rejected" on every URL,
// including "/". Using curl avoids pulling in a new npm dependency for GETs.

import { writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import type { Solicitation, IngestResult } from "../../lib/solicitation.ts";
import type { Diagnostics } from "../../lib/parseRfqGrid.ts";
import { parseRecordsFound, findGridHtml, splitRows, parseRow } from "../../lib/parseRfqGrid.ts";

const execFileP = promisify(execFile);

export const BASE = "https://www.dibbs.bsm.dla.mil";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_THROTTLE_MS = 300;
const COOKIE_JAR = path.join(os.tmpdir(), `dibbs-ingest-cookies-${process.pid}.txt`);

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

export async function fetchDay(date: string, maxPages: number | null): Promise<IngestResult> {
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  const diagnostics: Diagnostics = { unexpectedTechDocsSamples: [], badgeFilenames: new Set() };
  const rows: Solicitation[] = [];

  await establishSession();

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
  console.log(`[ingest:curl] ${date}: Records Found = ${recordsFound ?? "unknown"}`);

  let pageNum = 1;
  let hiddenFields = extractHiddenFields(html);
  const pageSize = 50;
  const totalPages = recordsFound !== null ? Math.ceil(recordsFound / pageSize) : null;

  while (true) {
    const rowsBefore = rows.length;
    for (const chunk of splitRows(gridHtml)) {
      const row = parseRow(chunk, date, fetchedAt, diagnostics, BASE);
      if (row) rows.push(row);
    }
    console.log(
      `[ingest:curl] ${date}: page ${pageNum}${totalPages ? `/${totalPages}` : ""} parsed, ${rows.length} rows so far`
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

    // The Page$N postback can come back 200 OK with the grid present but silently NOT
    // advance (observed live, 2026-11-23: a clean full-session repro stalls on Page$2
    // regardless of headers, cookies, or body field order -- see NOTES.md). Appending that
    // would duplicate page 1 under the guise of pages 2..N, so any page whose grid HTML is
    // byte-identical to the one just parsed is treated as a stall, not progress.
    if (nextGrid === gridHtml) {
      errors.push(
        `Page ${nextPageNum} returned content identical to page ${pageNum} — the site did not actually advance ` +
          `the page (postback stalled). Stopping with only the ${rows.length} genuinely distinct rows collected so far.`
      );
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
    console.log("[ingest:curl] Unexpected technicalDocuments cell content (raw HTML, up to 2 samples):");
    for (const sample of diagnostics.unexpectedTechDocsSamples) console.log("  " + sample);
  } else {
    console.log("[ingest:curl] No technicalDocuments cells seen other than None/blank on this run.");
  }
  console.log("[ingest:curl] Distinct badge icon filenames seen:", [...diagnostics.badgeFilenames].join(", ") || "(none)");

  return { date, recordsFound, rows, fetchedAt, errors };
}

export async function getLatestIssueDate(): Promise<string> {
  await establishSession();
  const html = await getPage(`${BASE}/Rfq/RfqDates.aspx?category=issue`);
  if (isRejectedOrWarningPage(html)) {
    throw new Error("Received the WAF/consent page instead of RfqDates.aspx");
  }
  const m = html.match(/Value=(\d{2}-\d{2}-\d{4})'[^>]*title='Link to RFQ data'/);
  if (!m) throw new Error("Could not find any issue date link on RfqDates.aspx");
  return m[1];
}
