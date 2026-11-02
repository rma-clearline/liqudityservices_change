// Mapping the inv_house_month rollup rows (DB shape) into HouseMonthRow for the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupRowsFromDb } from "../src/lib/invaluable-series.ts";

test("rollupRowsFromDb coerces DB values and keeps the HouseMonthRow shape", () => {
  const dbRows = [
    { house_key: "grogan", month: "2026-01", sold: "40", thv_usd: "1234.56", online_usd: "200", online_lots: "5", online_loose_usd: "260", timed_usd: "0" },
    { house_key: "neal", month: "2026-02", sold: 10, thv_usd: 500, online_usd: 0, online_lots: 0, online_loose_usd: 0, timed_usd: 500 },
  ];
  assert.deepEqual(rollupRowsFromDb(dbRows), [
    { house: "grogan", month: "2026-01", sold: 40, thv_usd: 1234.56, online_usd: 200, online_lots: 5, online_loose_usd: 260, timed_usd: 0 },
    { house: "neal", month: "2026-02", sold: 10, thv_usd: 500, online_usd: 0, online_lots: 0, online_loose_usd: 0, timed_usd: 500 },
  ]);
});

test("rollupRowsFromDb treats null/undefined numerics as 0 and stringifies keys", () => {
  const out = rollupRowsFromDb([{ house_key: "x", month: "2025-12", sold: null, thv_usd: undefined, online_usd: null, online_lots: null, online_loose_usd: null, timed_usd: null }]);
  assert.deepEqual(out, [{ house: "x", month: "2025-12", sold: 0, thv_usd: 0, online_usd: 0, online_lots: 0, online_loose_usd: 0, timed_usd: 0 }]);
});
