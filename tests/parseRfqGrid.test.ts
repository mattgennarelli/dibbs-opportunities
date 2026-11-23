// Regression tests for lib/parseRfqGrid.ts, using real HTML row snippets captured from a
// live full-day ingest (11-20-2026, page 73 -- see data/debug/) as fixtures, so these assert
// against the actual markup DIBBS served, not a guessed-at simplification of it.
// Run: npm test (node --test, no test framework dependency).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseRow, type Diagnostics } from "../lib/parseRfqGrid.ts";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const BASE = "https://www.dibbs.bsm.dla.mil";
const SOURCE_DATE = "11-20-2026";
const FETCHED_AT = "2026-11-23T00:00:00.000Z";

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

function freshDiagnostics(): Diagnostics {
  return { unexpectedTechDocsSamples: [], badgeFilenames: new Set() };
}

test("solicitation anchor with a <br>--»Attachments marker parses correctly and sets hasAttachments", () => {
  const chunk = loadFixture("row-with-attachments.html");
  const row = parseRow(chunk, SOURCE_DATE, FETCHED_AT, freshDiagnostics(), BASE);

  assert.ok(row, "row should parse, not be dropped");
  assert.equal(row.solicitationNumber, "SPE7M5-27-Q-0044");
  assert.equal(row.solicitationNumberRaw, "SPE7M527Q0044");
  assert.equal(row.hasAttachments, true);
  assert.equal(row.nsn, "5985-01-519-4851");
  assert.equal(row.nsnDigits, "5985015194851");
  assert.equal(row.status, "Open");
  assert.equal(row.purchaseRequestNumber, "7017437017");
  assert.equal(row.quantity, 2);
});

test("status wrapped in a nested <strong> tag (Removed) parses as a real string, not ''", () => {
  const chunk = loadFixture("row-with-removed-status.html");
  const row = parseRow(chunk, SOURCE_DATE, FETCHED_AT, freshDiagnostics(), BASE);

  assert.ok(row, "row should parse");
  assert.equal(row.status, "Removed");
  assert.notEqual(row.status, "", "status must never be an empty string");
  assert.equal(row.solicitationNumberRaw, "SPE7M527T3064");
  assert.equal(row.hasAttachments, false);
});

test("a normal row (no attachments marker, plain Open status) still parses the same as before", () => {
  const chunk = loadFixture("row-normal.html");
  const row = parseRow(chunk, SOURCE_DATE, FETCHED_AT, freshDiagnostics(), BASE);

  assert.ok(row, "row should parse");
  assert.equal(row.solicitationNumber, "SPE7M4-27-T-3639");
  assert.equal(row.solicitationNumberRaw, "SPE7M427T3639");
  assert.equal(row.hasAttachments, false);
  assert.equal(row.status, "Open");
  assert.equal(row.nsn, "4720-01-706-6690");
  assert.ok(row.badges.includes("fastAward"), "this row's fast-award icon should still be detected");
});

test("iconCFolder (Tech Docs icon, a different cell) is excluded from badges, and a set-aside icon (HUBZone) gets its own label instead of falling into 'other'", () => {
  const chunk = loadFixture("row-with-cfolder-and-hubzone.html");
  const diagnostics = freshDiagnostics();
  const row = parseRow(chunk, SOURCE_DATE, FETCHED_AT, diagnostics, BASE);

  assert.ok(row, "row should parse");
  assert.ok(diagnostics.badgeFilenames.has("iconCFolder"), "the icon was seen in the HTML");
  assert.ok(!row.badges.includes("other"), "iconCFolder must not produce an 'other' badge");
  assert.ok(row.badges.includes("hubZone"), "HUBZone icon should map to its own label");
  assert.equal(row.badges.length, 1, "only the real set-aside badge should remain, iconCFolder excluded entirely");
});

test("iconSb.gif (Small Business Set-Aside) maps to its own badge, not 'other'", () => {
  // Found 2026-11-23: `\bsb\b` never matches inside the single unbroken token "iconSb" --
  // \b needs a transition between a word char and a non-word char, and every character in
  // "iconSb" is a word char, so this regex silently never matched the single most common
  // set-aside icon on the site. Real row, real icon (alt="Small Business Set-Aside").
  const chunk = loadFixture("row-with-iconsb.html");
  const row = parseRow(chunk, SOURCE_DATE, FETCHED_AT, freshDiagnostics(), BASE);

  assert.ok(row, "row should parse");
  assert.ok(row.badges.includes("smallBusinessSetAside"), "iconSb should map to smallBusinessSetAside");
  assert.ok(!row.badges.includes("other"), "iconSb must never fall through to 'other'");
});

test("a status cell that truly has no text (hypothetical: only markup, no words) would parse as null, never ''", () => {
  // Synthetic (not a captured real row) -- there's no live example of a status cell with
  // genuinely zero text, but the empty-string normalization logic needs its own direct check
  // independent of which specific wrapper tags happen to surround "Removed" above.
  const chunk = [
    '<span id="x_lblRowNum">1</span>',
    '<span id="x_lblNsn"><a href="https://example.com">1234-56-789-0123</a></span>',
    '<span id="x_lblNomenclature">WIDGET</span>',
    '<span id="x_lblTechnicalDocuments">None</span>',
    '<span id="x_lblSolicitation"><a href="https://example.com">SPE1C1-27-Q-0001</a><br>rfqrec.aspx?sn=SPE1C127Q0001</span>',
    '<span id="x_lblStatus">&nbsp;<br>',
    '<span id="x_lblPr">1234567890<br>QTY: 1</span>',
    '<span id="x_lblIssued">11-20-2026</span>',
    '<span id="x_lblReturnBy">11-30-2026</span>',
  ].join("\n");
  const row = parseRow(chunk, SOURCE_DATE, FETCHED_AT, freshDiagnostics(), BASE);

  assert.ok(row, "row should still parse even with an empty status cell");
  assert.equal(row.status, null);
});
