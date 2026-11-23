// Fetches DLA DIBBS open-RFQ listings for one issue date by driving a real headless
// Chromium browser through the site's own pagination JS (__doPostBack). Default fetcher.
//
// Why: the curl fetcher's hand-built Page$N postback silently stalls on page 1 (200 OK,
// grid present, content byte-identical to the prior page) regardless of HTTP headers,
// cookies, or body field order -- bisected exhaustively on 2026-11-23, see NOTES.md. A real
// browser executes the page's own click handler, which we can't fully replicate via curl.

import { chromium, type Page } from "playwright";
import type { Solicitation, IngestResult } from "../../lib/solicitation.ts";
import type { Diagnostics } from "../../lib/parseRfqGrid.ts";
import { parseRecordsFound, splitRows, parseRow, rowKey } from "../../lib/parseRfqGrid.ts";

const BASE = "https://www.dibbs.bsm.dla.mil";
const PAGE_SIZE = 50;

async function dismissDodWarningIfPresent(page: Page): Promise<void> {
  if (!page.url().includes("dodwarning.aspx")) return;
  await page.click("#butAgree");
  await page.waitForLoadState("networkidle");
}

// Clicking a pager link submits the grid's postback form, which is a real full-page
// navigation (ASP.NET WebForms, not an AJAX partial update) -- so completion must be
// detected via navigation/network-idle, never a fixed sleep or a DOM-text comparison (the
// old row's text briefly becomes undefined while the old document is torn down, which would
// otherwise look like "changed" well before the new page has actually loaded).
async function clickPagerLink(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), locator.click()]);
}

async function clickPage(page: Page, targetPage: number): Promise<void> {
  // The GridView pager shows a limited window of page-number links (e.g. 1-10, then "...").
  // The "..." link's own postback argument is the first page number of the NEXT window
  // (e.g. Page$11), so repeatedly clicking it and re-checking is enough to roll the window
  // forward until the target page number becomes visible.
  for (let attempt = 0; attempt < 50; attempt++) {
    const target = page.locator(`a[href*="'Page$${targetPage}'"]`).first();
    if (await target.count() > 0) {
      await clickPagerLink(page, target);
      return;
    }
    // Not visible yet: click the highest-numbered page link currently shown (standard
    // GridView numeric paging renders this as "..." when more pages exist beyond it).
    const pageLinks = page.locator('a[href*="\'Page$"]');
    const count = await pageLinks.count();
    if (count === 0) throw new Error(`No pager links found while looking for page ${targetPage}`);
    await clickPagerLink(page, pageLinks.last());
  }
  throw new Error(`Could not locate a pager link for page ${targetPage} after 50 window-roll attempts`);
}

export async function fetchDay(date: string, maxPages: number | null): Promise<IngestResult> {
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  const diagnostics: Diagnostics = { unexpectedTechDocsSamples: [], badgeFilenames: new Set() };
  const rows: Solicitation[] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dayUrl = `${BASE}/RFQ/RfqRecs.aspx?category=issue&TypeSrch=dt&Value=${date}`;
    await page.goto(dayUrl, { waitUntil: "networkidle" });
    await dismissDodWarningIfPresent(page);
    if (page.url() !== dayUrl && !page.url().startsWith(dayUrl)) {
      await page.goto(dayUrl, { waitUntil: "networkidle" });
    }

    const html0 = await page.content();
    const recordsFound = parseRecordsFound(html0);
    console.log(`[ingest:playwright] ${date}: Records Found = ${recordsFound ?? "unknown"}`);
    const totalPages = recordsFound !== null ? Math.ceil(recordsFound / PAGE_SIZE) : null;

    async function parseCurrentPage(pageNum: number): Promise<Solicitation[]> {
      const gridHtml = await page.evaluate(
        () => document.getElementById("ctl00_cph1_grdRfqSearch")?.outerHTML ?? ""
      );
      if (!gridHtml) throw new Error(`Grid element not found on page ${pageNum} for ${date}`);
      const pageRows: Solicitation[] = [];
      for (const chunk of splitRows(gridHtml)) {
        const row = parseRow(chunk, date, fetchedAt, diagnostics, BASE);
        if (row) pageRows.push(row);
      }
      return pageRows;
    }

    let pageNum = 1;
    const seenFirstRowKeys = new Set<string>();

    // Page 1 is already loaded (no click needed).
    let pageRows = await parseCurrentPage(pageNum);

    while (true) {
      if (pageRows.length === 0) {
        errors.push(`Page ${pageNum} parsed zero rows; stopping.`);
        break;
      }
      const firstKey = rowKey(pageRows[0]);
      if (seenFirstRowKeys.has(firstKey)) {
        errors.push(
          `Page ${pageNum}'s first row (${firstKey}) repeats a previously seen page's first row -- ` +
            `pagination did not advance. Stopping with ${rows.length} rows collected so far.`
        );
        break;
      }
      seenFirstRowKeys.add(firstKey);
      rows.push(...pageRows);
      console.log(
        `[ingest:playwright] ${date}: page ${pageNum}${totalPages ? `/${totalPages}` : ""} parsed, ${rows.length} rows so far`
      );

      if (recordsFound !== null && rows.length >= recordsFound) break;
      if (maxPages !== null && pageNum >= maxPages) {
        errors.push(`Stopped after --max-pages ${maxPages} (sample run; ${rows.length}/${recordsFound ?? "unknown"} rows fetched).`);
        break;
      }

      const nextPageNum = pageNum + 1;
      let nextRows: Solicitation[];
      try {
        await clickPage(page, nextPageNum);
        nextRows = await parseCurrentPage(nextPageNum);
        if (nextRows.length > 0 && seenFirstRowKeys.has(rowKey(nextRows[0]))) {
          // Stalled: the postback didn't actually advance. Guard per spec: retry this one
          // page click once before failing loudly.
          await clickPage(page, nextPageNum);
          nextRows = await parseCurrentPage(nextPageNum);
        }
      } catch (err) {
        errors.push(
          `Could not click to page ${nextPageNum}: ${err instanceof Error ? err.message : String(err)}. ` +
            `Stopped with ${rows.length} rows.`
        );
        break;
      }

      if (nextRows.length > 0 && seenFirstRowKeys.has(rowKey(nextRows[0]))) {
        errors.push(
          `Page ${nextPageNum}'s first row repeats a previously seen page after clicking and one retry -- ` +
            `pagination stalled. Stopping with ${rows.length} rows collected so far.`
        );
        break;
      }

      pageNum = nextPageNum;
      pageRows = nextRows;
      if (pageNum > 500) {
        errors.push(`Aborted after ${pageNum} pages as a safety stop (recordsFound=${recordsFound}).`);
        break;
      }
    }

    // Completeness check: unique rows must equal Records Found, or this is reported loudly,
    // never silently truncated or fabricated (CLAUDE.md: never invent values, missing = null).
    const uniqueKeys = new Set(rows.map(rowKey));
    if (maxPages === null && recordsFound !== null && uniqueKeys.size !== recordsFound) {
      errors.push(
        `Completeness check failed: ${uniqueKeys.size} unique rows parsed but site reported ` +
          `Records Found: ${recordsFound}.`
      );
    }
    if (uniqueKeys.size !== rows.length) {
      errors.push(`Found ${rows.length - uniqueKeys.size} duplicate row(s) across pages (same composite key twice).`);
    }

    if (diagnostics.unexpectedTechDocsSamples.length > 0) {
      console.log("[ingest:playwright] Unexpected technicalDocuments cell content (raw HTML, up to 2 samples):");
      for (const sample of diagnostics.unexpectedTechDocsSamples) console.log("  " + sample);
    }
    console.log(
      "[ingest:playwright] Distinct badge icon filenames seen:",
      [...diagnostics.badgeFilenames].join(", ") || "(none)"
    );

    return { date, recordsFound, rows, fetchedAt, errors };
  } finally {
    await browser.close();
  }
}
