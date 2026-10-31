// Invaluable panel report: the GMS proxy series and its validation against the few
// figures Invaluable has disclosed. USD via lqdt.fx_rates (stored as units per USD).
//   node scripts/invaluable-report.mjs [--house KEY] [--grain month|quarter]
import { connect } from "./invaluable/db.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const grain = opt("--grain") === "quarter" ? "quarter" : "month";
const fmtM = (n) => "$" + (Number(n) / 1e6).toFixed(2) + "M";
const pct = (n) => (n == null ? "   —  " : ((n * 100).toFixed(1) + "%").padStart(6));

const pool = await connect();
const periodExpr = grain === "quarter"
  ? "CONCAT(YEAR(c.event_date_local), 'Q', DATEPART(quarter, c.event_date_local))"
  : "CONVERT(char(7), c.event_date_local, 126)";
// Rate on the sale day, else the latest earlier rate; USD = native / units-per-USD.
const q = `
  WITH lots AS (
    SELECT c.house_key, ${periodExpr} AS period, c.is_timed, l.is_sold, l.online_won, l.hammer, l.online_hammer, ISNULL(l.currency, 'USD') AS currency, c.event_date_local
    FROM lqdt.inv_catalogs c JOIN lqdt.inv_lots l ON l.catalog_ref = c.catalog_ref
    WHERE c.status IN ('complete','partial') AND c.lots_fetched >= 0.9 * c.nb_lots AND (@h IS NULL OR c.house_key = @h)
  ), fx AS (
    SELECT lots.*, CASE WHEN currency = 'USD' THEN 1.0 ELSE (
      SELECT TOP (1) usd_per_unit FROM lqdt.fx_rates f WHERE f.currency = lots.currency AND f.date <= CONVERT(char(10), lots.event_date_local, 126) ORDER BY f.date DESC) END AS units_per_usd
    FROM lots
  )
  SELECT house_key, period,
    SUM(CASE WHEN is_sold = 1 THEN 1 ELSE 0 END) AS sold,
    SUM(CASE WHEN is_sold = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS thv_usd,
    SUM(CASE WHEN online_won = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS online_usd,
    SUM(CASE WHEN online_won = 1 THEN 1 ELSE 0 END) AS online_lots,
    SUM(CASE WHEN is_sold = 1 AND ABS(ISNULL(online_hammer,0) - ISNULL(hammer,0)) <= CASE WHEN hammer * 0.005 > 1 THEN hammer * 0.005 ELSE 1 END THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS online_loose_usd,
    SUM(CASE WHEN is_timed = 1 AND is_sold = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS timed_usd
  FROM fx GROUP BY house_key, period ORDER BY period, house_key`;
const rows = (await pool.request().input("h", opt("--house")).query(q)).recordset;
await pool.close();

// Panel total per period + Y/Y where the prior-year period exists.
const byPeriod = new Map();
const byHouse = new Map(); // house -> period -> { thv, online }: like-for-like Y/Y uses only houses present in both periods
for (const r of rows) {
  const h = byHouse.get(r.house_key) ?? new Map();
  h.set(r.period, { thv: Number(r.thv_usd), online: Number(r.online_usd) });
  byHouse.set(r.house_key, h);
  const t = byPeriod.get(r.period) ?? { sold: 0, thv: 0, online: 0, loose: 0, timed: 0, houses: new Set() };
  t.sold += r.sold; t.thv += Number(r.thv_usd); t.online += Number(r.online_usd); t.loose += Number(r.online_loose_usd); t.timed += Number(r.timed_usd); t.houses.add(r.house_key);
  byPeriod.set(r.period, t);
}
const lfl = (p, pp) => {
  let thv = 0, pthv = 0, onl = 0, ponl = 0, n = 0;
  for (const [, h] of byHouse) { const a = h.get(p), b = h.get(pp); if (a && b && a.thv > 0 && b.thv > 0) { n++; thv += a.thv; pthv += b.thv; onl += a.online; ponl += b.online; } }
  // Equal-weight view: the median of per-house online-won Y/Y. The dollar-weighted
  // aggregate can be carried by one large house ramping its online channel (John
  // Moran 2026Q1: +231%); the platform's disclosed growth averages thousands of houses.
  const per = [];
  for (const [, h] of byHouse) { const a = h.get(p), b = h.get(pp); if (a && b && a.online > 0 && b.online > 0) per.push(a.online / b.online - 1); }
  per.sort((x, y) => x - y);
  const med = per.length ? (per.length % 2 ? per[(per.length - 1) / 2] : (per[per.length / 2 - 1] + per[per.length / 2]) / 2) : null;
  return { n, thvYoy: n && pthv > 0 ? thv / pthv - 1 : null, onlYoy: n && ponl > 0 ? onl / ponl - 1 : null, medOnlYoy: med, nMed: per.length };
};
const today = new Date().toISOString().slice(0, 10);
const openPeriod = grain === "quarter" ? today.slice(0, 4) + "Q" + (Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1) : today.slice(0, 7);
const prior = (p) => (grain === "quarter" ? String(Number(p.slice(0, 4)) - 1) + p.slice(4) : String(Number(p.slice(0, 4)) - 1) + p.slice(4));
console.log(`\nPanel GMS proxy by ${grain} (USD; online-won = inferred platform wins with >=1 online bid; loose = equality test alone, an upper bound; share = online ÷ hammer)`);
console.log("period    houses  sold       THV   online-won  share  loose  timed%   THV Y/Y  online Y/Y  median-house online Y/Y");
for (const [p, t] of [...byPeriod].sort()) {
  const y = lfl(p, prior(p)); const thvYoy = y.thvYoy, onlYoy = y.onlYoy; const tag = (y.n ? "  (" + y.n + " lfl)" : "") + (p >= openPeriod ? " *open" : "");
  console.log(`${p.padEnd(9)} ${String(t.houses.size).padStart(5)} ${String(t.sold).padStart(5)} ${fmtM(t.thv).padStart(9)} ${fmtM(t.online).padStart(10)} ${pct(t.thv ? t.online / t.thv : null)} ${pct(t.thv ? t.loose / t.thv : null)} ${pct(t.thv ? t.timed / t.thv : null)}  ${pct(thvYoy)}    ${pct(onlYoy)}    ${pct(y.medOnlYoy)}${y.nMed ? " (" + y.nMed + ")" : ""}${tag}`);
}
console.log(`\nDisclosed reference points (Invaluable + AuctionZip, platform-wide): CY2025 GMS > $500M; Q1 2026 GMS $125M, +17% Y/Y, share of gavel 14.7%; May 2026 net GMS +20% Y/Y.`);
console.log(`Validation = the panel's online-won Y/Y for the same windows vs those growth rates, and its share vs 14.7%; a level comparison needs the panel's share of the platform, which is unknown.`);
console.log('* open = current period, incomplete; Y/Y compares only houses with sales in both periods (n in parentheses).');
