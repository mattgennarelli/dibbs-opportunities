// Regression tests for the sub-line nesting/labeling logic in lib/firstArticle.ts -- the
// pure part of the "full fix" (2026-11-23) and its generalization to "sub-lines" (any
// non-NSN row with a real-NSN sibling, not just First Article Test): sub-lines never match
// filters/search on their own, always travel with their parent, and a parent + its
// sub-lines must never be split across pages. The SQL-side half of that fix
// (parentRowCondition, isSublineSql, hasFirstArticleLineSql, hasLotTestingLineSql in
// lib/apiQuery.ts) requires a live Postgres connection and is instead verified against the
// real DB -- see docs/engineering-notes.md.
// Run: npm test (node --test, no test framework dependency).

import { test } from "node:test";
import assert from "node:assert/strict";
import { withSublinesAssembled, sublineLabel, isLotTestingNomenclature, type SublineRow } from "../lib/firstArticle.ts";

function row(solicitationNumberRaw: string): SublineRow {
  return { solicitation_number_raw: solicitationNumberRaw };
}

test("a parent with a sub-line gets that sub-line nested directly after it", () => {
  const parents = [row("SOL1")];
  const sublines = [row("SOL1")];
  const out = withSublinesAssembled(parents, sublines);
  assert.deepEqual(out, [parents[0], sublines[0]]);
});

test("a parent with no matching sub-line is left alone, even if an unrelated sub-line is fetched", () => {
  const parents = [row("SOL1")];
  const out = withSublinesAssembled(parents, [row("SOL2")]);
  assert.deepEqual(out, parents);
});

test("two parent rows sharing the same solicitation_number_raw: the sub-line nests once, under the first, never duplicated under the second", () => {
  const parentA = row("SOL1");
  const parentB = row("SOL1");
  const subline = row("SOL1");
  const out = withSublinesAssembled([parentA, parentB], [subline]);
  assert.deepEqual(out, [parentA, subline, parentB]);
});

test("multiple parents, each with their own sub-line, interleave correctly (no cross-contamination)", () => {
  const parentA = row("SOL1");
  const sublineA = row("SOL1");
  const parentB = row("SOL2");
  const sublineB = row("SOL2");
  const out = withSublinesAssembled([parentA, parentB], [sublineA, sublineB]);
  assert.deepEqual(out, [parentA, sublineA, parentB, sublineB]);
});

test("a solicitation with multiple sub-lines nests all of them under its one parent, in order", () => {
  const parent = row("SOL1");
  const sub1 = row("SOL1");
  const sub2 = row("SOL1");
  const out = withSublinesAssembled([parent], [sub1, sub2]);
  assert.deepEqual(out, [parent, sub1, sub2]);
});

test("sublineLabel: First Article lines get their special-cased Government/Contractor format", () => {
  assert.equal(sublineLabel("GOVERNMENT FIRST ARTIC", true), "↳ First Article test (Government)");
  assert.equal(sublineLabel("CONTRACTOR FIRST ARTIC", true), "↳ First Article test (Contractor)");
});

test("sublineLabel: any other sub-line kind is just its own nomenclature, sentence-cased", () => {
  assert.equal(sublineLabel("PRODUCTION LOT TESTING", false), "↳ Production lot testing");
  assert.equal(sublineLabel("NON-NSN ITEM", false), "↳ Non-nsn item");
});

test("isLotTestingNomenclature matches Production Lot Testing but not Production Control Testing (a distinct, unverified category)", () => {
  assert.equal(isLotTestingNomenclature("PRODUCTION LOT TESTING"), true);
  assert.equal(isLotTestingNomenclature("PRODUCTION CONTROL TESTING"), false);
  assert.equal(isLotTestingNomenclature("NON-NSN ITEM"), false);
});
