// Recompute premium_rate / hammer / online_won for stored lots from their raw fields
// (posted result, the naive lot rate, the top online bid, bid count) with the per-lot
// premium-rate resolution in lib.mjs. Only premium-inclusive catalogs can change.
// Idempotent; prints per-house before/after.
//   node scripts/invaluable-rederive.mjs [--house KEY] [--dry-run]
import { createRequire } from "node:module";
import { connect } from "./invaluable/db.mjs";
import { catalogRates, deriveLot } from "./invaluable/lib.mjs";

const sql = createRequire(import.meta.url)("mssql");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes("--dry-run");
const fmtM = (n) => "$" + (Number(n) / 1e6).toFixed(2) + "M";

const pool = await connect();
const cats = (await pool.request().input("h", sql.NVarChar(40), opt("--house")).query(`
  SELECT catalog_ref, house_key, is_timed, premium_rate FROM lqdt.inv_catalogs
  WHERE results_include_premium = 1 AND status IN ('complete','partial') AND (@h IS NULL OR house_key = @h)
  ORDER BY house_key, event_date_local`)).recordset;
const stat = new Map();
const bump = (h, k, v = 1) => { const s = stat.get(h) ?? { catalogs: 0, lots: 0, changed: 0, onlineBefore: 0, onlineAfter: 0, usdBefore: 0, usdAfter: 0, hammerBefore: 0, hammerAfter: 0 }; s[k] += v; stat.set(h, s); };
for (const c of cats) {
  const lots = (await pool.request().input("r", sql.NVarChar(20), c.catalog_ref)
    .query("SELECT lot_ref, is_sold, price_result, premium_rate, hammer, online_hammer, bid_count, online_won FROM lqdt.inv_lots WHERE catalog_ref = @r")).recordset;
  const cat = { premiumRate: c.premium_rate == null ? null : Number(c.premium_rate), resultsIncludePremium: true, isTimed: !!c.is_timed };
  // Rebuild the lot-API shape from stored columns: the naive buyersPremium is rate x result.
  const views = lots.map((l) => ({
    isSold: !!l.is_sold, priceResult: Number(l.price_result) || 0,
    buyersPremium: l.premium_rate != null && l.price_result ? Number(l.premium_rate) * Number(l.price_result) : 0,
    price: Number(l.online_hammer) || 0, bidCount: Number(l.bid_count) || 0, old: l,
  }));
  const rates = catalogRates(views, cat);
  const changed = [];
  bump(c.house_key, "catalogs"); bump(c.house_key, "lots", lots.length);
  for (const v of views) {
    const d = deriveLot(v, cat, rates);
    const before = !!v.old.online_won, after = d.onlineWon;
    const oldHammer = v.old.hammer == null ? null : Number(v.old.hammer);
    if (v.isSold) { bump(c.house_key, "hammerBefore", oldHammer ?? 0); bump(c.house_key, "hammerAfter", d.hammer ?? 0); }
    if (before) bump(c.house_key, "usdBefore", oldHammer ?? 0), bump(c.house_key, "onlineBefore");
    if (after) bump(c.house_key, "usdAfter", d.hammer ?? 0), bump(c.house_key, "onlineAfter");
    const sameHammer = oldHammer == null ? d.hammer == null : d.hammer != null && Math.abs(oldHammer - d.hammer) < 0.005;
    const oldRate = v.old.premium_rate == null ? null : Number(v.old.premium_rate);
    const sameRate = oldRate == null ? d.rate == null : d.rate != null && Math.abs(oldRate - d.rate) < 0.0001;
    if (before !== after || !sameHammer || !sameRate) changed.push({ lot_ref: v.old.lot_ref, premium_rate: d.rate, hammer: d.hammer, online_won: after });
  }
  bump(c.house_key, "changed", changed.length);
  if (dry || !changed.length) continue;
  for (let i = 0; i < changed.length; i += 2000) {
    await pool.request().input("j", sql.NVarChar(sql.MAX), JSON.stringify(changed.slice(i, i + 2000))).query(`
      UPDATE l SET l.premium_rate = j.premium_rate, l.hammer = j.hammer, l.online_won = j.online_won
      FROM lqdt.inv_lots l JOIN OPENJSON(@j) WITH (lot_ref NVARCHAR(20) '$.lot_ref', premium_rate DECIMAL(6,4) '$.premium_rate',
        hammer DECIMAL(18,2) '$.hammer', online_won BIT '$.online_won') j ON j.lot_ref = l.lot_ref`);
  }
}
console.log((dry ? "DRY RUN " : "") + "premium-inclusive catalogs re-derived\nhouse         cats    lots  changed  online lots before->after   online $ before->after   hammer $ before->after");
for (const [h, s] of [...stat].sort()) console.log(`${h.padEnd(13)} ${String(s.catalogs).padStart(4)} ${String(s.lots).padStart(7)} ${String(s.changed).padStart(8)}   ${String(s.onlineBefore).padStart(6)} -> ${String(s.onlineAfter).padEnd(6)}   ${fmtM(s.usdBefore).padStart(9)} -> ${fmtM(s.usdAfter).padEnd(9)}   ${fmtM(s.hammerBefore).padStart(9)} -> ${fmtM(s.hammerAfter)}`);
await pool.close();
