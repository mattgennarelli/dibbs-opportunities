// Regression tests for the First Article (FA) nesting/labeling logic in lib/firstArticle.ts
// -- the pure part of the "full fix" (2026-11-23): FA rows never match filters/search on
// their own, always travel with their parent (or, if genuinely orphaned, stand alone), and
// a parent + its FA line must never be split across pages. The SQL-side half of that fix
// (parentRowCondition, hasFirstArticleLineSql, hasNonFirstArticleParentSql in
// lib/apiQuery.ts) requires a live Postgres connection and is instead verified against the
// real DB -- see docs/engineering-notes.md.
// Run: npm test (node --test, no test framework dependency).

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFirstArticlesAssembled, firstArticleVariantLabel, firstArticleRowLabel, type FirstArticleRow } from "../lib/firstArticle.ts";

function row(solicitationNumberRaw: string, hasFirstArticleSibling: boolean): FirstArticleRow {
  return { solicitation_number_raw: solicitationNumberRaw, has_first_article_sibling: hasFirstArticleSibling };
}

test("a parent with an FA child gets that child nested directly after it", () => {
  const parents = [row("SOL1", true)];
  const children = [row("SOL1", false)];
  const out = withFirstArticlesAssembled(parents, children, []);
  assert.deepEqual(out, [parents[0], children[0]]);
});

test("a parent with no FA sibling is left alone, even if an unrelated child/orphan is fetched", () => {
  const parents = [row("SOL1", false)];
  const out = withFirstArticlesAssembled(parents, [row("SOL2", false)], []);
  assert.deepEqual(out, parents);
});

test("two parent rows sharing the same solicitation_number_raw: the FA child nests once, under the first, never duplicated under the second", () => {
  const parentA = row("SOL1", true);
  const parentB = row("SOL1", true);
  const child = row("SOL1", false);
  const out = withFirstArticlesAssembled([parentA, parentB], [child], []);
  assert.deepEqual(out, [parentA, child, parentB]);
});

test("multiple parents, each with their own FA child, interleave correctly (no cross-contamination)", () => {
  const parentA = row("SOL1", true);
  const childA = row("SOL1", false);
  const parentB = row("SOL2", true);
  const childB = row("SOL2", false);
  const out = withFirstArticlesAssembled([parentA, parentB], [childA, childB], []);
  assert.deepEqual(out, [parentA, childA, parentB, childB]);
});

test("orphans (no parent on the page, or anywhere) are appended at the end, unattached", () => {
  const parents = [row("SOL1", true)];
  const children = [row("SOL1", false)];
  const orphan = row("SOL-ORPHAN", false);
  const out = withFirstArticlesAssembled(parents, children, [orphan]);
  assert.deepEqual(out, [parents[0], children[0], orphan]);
});

test("firstArticleVariantLabel reads Government/Contractor from the truncated nomenclature", () => {
  assert.equal(firstArticleVariantLabel("GOVERNMENT FIRST ARTIC"), "Government");
  assert.equal(firstArticleVariantLabel("CONTRACTOR FIRST ARTIC"), "Contractor");
  assert.equal(firstArticleVariantLabel("SOMETHING ELSE"), "");
});

test("firstArticleRowLabel: nested label for a real child, standalone label for an orphan", () => {
  assert.equal(firstArticleRowLabel("GOVERNMENT FIRST ARTIC", false), "↳ First Article test (Government)");
  assert.equal(
    firstArticleRowLabel("CONTRACTOR FIRST ARTIC", true),
    "First Article test (Contractor) — parent item not listed"
  );
});
