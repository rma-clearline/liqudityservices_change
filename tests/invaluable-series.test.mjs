// Pure series math for the Invaluable panel page. Runs on Node's own test runner with
// native type stripping (Node >= 22.18):  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priorPeriod,
  openPeriod,
  median,
  likeForLike,
  buildSeries,
  foldHouses,
  houseRows,
  latestClosed,
} from "../src/lib/invaluable-series.ts";

const hp = (period, house, thv_usd, online_usd) => ({ period, house, thv_usd, online_usd });
const pr = (period, thv_usd, online_usd, extra = {}) => ({
  period, houses: 2, sold: 10, thv_usd, online_usd, online_lots: 3, online_loose_usd: online_usd, timed_usd: 0, ...extra,
});

test("priorPeriod shifts a quarter or month label back one year", () => {
  assert.equal(priorPeriod("2026Q1"), "2025Q1");
  assert.equal(priorPeriod("2026-03"), "2025-03");
});

test("openPeriod is the period that contains today", () => {
  assert.equal(openPeriod("quarter", "2026-10-31"), "2026Q4");
  assert.equal(openPeriod("month", "2026-10-31"), "2026-10");
  assert.equal(openPeriod("quarter", "2026-01-05"), "2026Q1");
});

test("median of an empty list is null; odd and even lengths", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("likeForLike compares only houses present in both periods", () => {
  const rows = [
    hp("2026Q1", "a", 200, 20), hp("2026Q1", "b", 100, 30), hp("2026Q1", "c", 500, 50),
    hp("2025Q1", "a", 100, 10), hp("2025Q1", "b", 100, 10),
  ];
  const y = likeForLike(rows, "2026Q1");
  assert.equal(y.n, 2);
  assert.equal(y.hammerYoy, 0.5);
  assert.equal(y.onlineYoy, 1.5);
  assert.equal(y.medianOnlineYoy, 1.5);
  assert.equal(y.nMedian, 2);
});

test("likeForLike with no prior-year data is empty", () => {
  const y = likeForLike([hp("2026Q1", "a", 200, 20)], "2026Q1");
  assert.deepEqual(y, { n: 0, hammerYoy: null, onlineYoy: null, medianOnlineYoy: null, nMedian: 0 });
});

test("likeForLike median skips houses with zero online in either period but keeps them in the weighted figure", () => {
  const rows = [
    hp("2026Q1", "a", 200, 20), hp("2026Q1", "b", 100, 30),
    hp("2025Q1", "a", 100, 10), hp("2025Q1", "b", 100, 0),
  ];
  const y = likeForLike(rows, "2026Q1");
  assert.equal(y.n, 2);
  assert.equal(y.onlineYoy, 4);
  assert.equal(y.medianOnlineYoy, 1);
  assert.equal(y.nMedian, 1);
});

test("buildSeries derives shares, the loose range extra, Y/Y and the open flag", () => {
  const periods = [pr("2025Q1", 200, 20, { online_loose_usd: 25 }), pr("2026Q1", 300, 60, { online_loose_usd: 66, timed_usd: 30 }), pr("2026Q4", 50, 10)];
  const byHouse = [hp("2025Q1", "a", 200, 20), hp("2026Q1", "a", 300, 60), hp("2026Q4", "a", 50, 10), hp("2025Q4", "a", 40, 5)];
  const s = buildSeries(periods, byHouse, "quarter", "2026-10-31");
  assert.deepEqual(s.map((r) => r.period), ["2025Q1", "2026Q1", "2026Q4"]);
  const q1 = s[1];
  assert.equal(q1.share, 0.2);
  assert.equal(q1.shareLoose, 0.22);
  assert.equal(q1.shareTimed, 0.1);
  assert.equal(q1.looseExtra, 6);
  assert.equal(q1.open, false);
  assert.equal(q1.lfl.onlineYoy, 2);
  assert.equal(q1.lfl.hammerYoy, 0.5);
  const q4 = s[2];
  assert.equal(q4.open, true);
  assert.equal(q4.lfl.onlineYoy, null, "open periods carry no Y/Y");
});

test("buildSeries never reports a negative loose extra", () => {
  const s = buildSeries([pr("2026Q1", 300, 60, { online_loose_usd: 50 })], [], "quarter", "2026-10-31");
  assert.equal(s[0].looseExtra, 0);
});

test("foldHouses keeps the largest houses in a fixed order and folds the rest into Other", () => {
  const byHouse = [
    hp("2025Q1", "big", 0, 100), hp("2025Q1", "mid", 0, 50), hp("2025Q1", "small", 0, 10),
    hp("2026Q1", "big", 0, 120), hp("2026Q1", "small", 0, 20),
  ];
  const f = foldHouses(byHouse, ["2025Q1", "2026Q1"], "online_usd", 2);
  assert.deepEqual(f.houses, ["big", "mid", "Other"]);
  assert.deepEqual(f.rows, [
    { period: "2025Q1", big: 100, mid: 50, Other: 10 },
    { period: "2026Q1", big: 120, mid: 0, Other: 20 },
  ]);
});

test("foldHouses without a tail has no Other series", () => {
  const f = foldHouses([hp("2026Q1", "a", 0, 5), hp("2026Q1", "b", 0, 7)], ["2026Q1"], "online_usd", 7);
  assert.deepEqual(f.houses, ["b", "a"]);
  assert.deepEqual(f.rows, [{ period: "2026Q1", b: 7, a: 5 }]);
});

test("houseRows lists a period's houses by online-won with share and Y/Y", () => {
  const byHouse = [hp("2026Q1", "a", 200, 20), hp("2026Q1", "b", 100, 30), hp("2025Q1", "b", 100, 10)];
  const rows = houseRows(byHouse, "2026Q1");
  assert.deepEqual(rows, [
    { house: "b", thv: 100, online: 30, share: 0.3, hammerYoy: 0, onlineYoy: 2 },
    { house: "a", thv: 200, online: 20, share: 0.1, hammerYoy: null, onlineYoy: null },
  ]);
});

test("latestClosed is the last non-open row", () => {
  const s = buildSeries([pr("2026Q3", 1, 1), pr("2026Q4", 1, 1)], [], "quarter", "2026-10-31");
  assert.equal(latestClosed(s)?.period, "2026Q3");
  assert.equal(latestClosed([]), null);
});

test("quarterOf maps a month label to its calendar quarter", async () => {
  const { quarterOf } = await import("../src/lib/invaluable-series.ts");
  assert.equal(quarterOf("2026-02"), "2026Q1");
  assert.equal(quarterOf("2026-12"), "2026Q4");
});

test("rollupPeriods builds month and quarter panel totals and per-house rows from one house-month table", async () => {
  const { rollupPeriods } = await import("../src/lib/invaluable-series.ts");
  const row = (house, month, sold, thv_usd, online_usd, online_lots, online_loose_usd, timed_usd) => ({ house, month, sold, thv_usd, online_usd, online_lots, online_loose_usd, timed_usd });
  const out = rollupPeriods([row("b", "2026-02", 3, 200, 20, 2, 25, 0), row("a", "2026-01", 2, 100, 10, 1, 12, 0), row("a", "2026-02", 1, 50, 5, 1, 5, 50)]);
  assert.deepEqual(out.month, [
    { period: "2026-01", houses: 1, sold: 2, thv_usd: 100, online_usd: 10, online_lots: 1, online_loose_usd: 12, timed_usd: 0 },
    { period: "2026-02", houses: 2, sold: 4, thv_usd: 250, online_usd: 25, online_lots: 3, online_loose_usd: 30, timed_usd: 50 },
  ]);
  assert.deepEqual(out.quarter, [{ period: "2026Q1", houses: 2, sold: 6, thv_usd: 350, online_usd: 35, online_lots: 4, online_loose_usd: 42, timed_usd: 50 }]);
  assert.deepEqual(out.byHouse.month, [
    { period: "2026-01", house: "a", thv_usd: 100, online_usd: 10 },
    { period: "2026-02", house: "a", thv_usd: 50, online_usd: 5 },
    { period: "2026-02", house: "b", thv_usd: 200, online_usd: 20 },
  ]);
  assert.deepEqual(out.byHouse.quarter, [
    { period: "2026Q1", house: "a", thv_usd: 150, online_usd: 15 },
    { period: "2026Q1", house: "b", thv_usd: 200, online_usd: 20 },
  ]);
});
