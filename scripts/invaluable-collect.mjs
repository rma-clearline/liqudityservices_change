// Invaluable / AuctionZip panel collector (permission-based). For each house in
// scripts/invaluable-panel.json: enumerate hosted catalogs from the house's own
// past-auctions pages, read catalog meta from the open catalog API, anchor on the
// catalog page's first 20 lot ids, then sweep the contiguous lot-id block through
// the open lot API until every lot is in. Idempotent; complete catalogs are skipped.
//   node scripts/invaluable-collect.mjs [--house KEY] [--max-catalogs N] [--refresh] [--summary-only]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get, catalogPathsIn, linksUnder, pageOne, schedulePremium, deriveLot, stats } from "./invaluable/lib.mjs";
import { connect, upsertHouse, upsertCatalog, completeRefs, upsertLots, monthlySummary } from "./invaluable/db.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const flag = (k) => args.includes(k);
const panel = JSON.parse(readFileSync(path.join(DIR, "invaluable-panel.json"), "utf8"));
const houses = panel.houses.filter((h) => h.enabled !== false && (!opt("--house") || h.key === opt("--house")));
const MAX = Number(opt("--max-catalogs")) || Infinity;
const MISS_RUN = 25; // consecutive foreign/404 ids that end a sweep direction
const fmtM = (n) => "$" + (Number(n) / 1e6).toFixed(2) + "M";

const pool = await connect();
let catalogsDone = 0, lotsWritten = 0;

// Houses without a private-label site: their public Invaluable house page lists every
// catalog as /catalog/<REF> (no prices on it); the catalog page + both APIs are served
// for ANY house by www.auctionzip.com. That host's WAF challenges unknown automated
// clients (empty HTTP 202) and the run then stops the host — it must be ALLOWLISTED by
// the platform before this kind collects (ask LQDT; permission exists). Using another
// house's domain as a gateway instead is deliberately NOT done: it would be routing
// around a bot check. One house-page request per run, at Invaluable's 10s crawl-delay.
const GATEWAY = "www.auctionzip.com";
const apiHost = (h) => (h.kind === "invaluable" ? GATEWAY : h.domain);

async function discover(h) {
  const base = `https://${h.domain}`;
  const paths = new Map();
  for (const [ref, p] of Object.entries(h.catalogs ?? {})) paths.set(ref, p);
  if (h.kind === "invaluable" && h.house_page) {
    const page = await get(`https://www.invaluable.com${h.house_page}`);
    if (page) for (const m of page.matchAll(/\/catalog\/([A-Z0-9]{10})/g)) paths.set(m[1], `auction-catalog/catalog_${m[1]}`);
    return paths;
  }
  if (h.past_list) {
    const list = await get(base + h.past_list);
    if (list) {
      for (const [r, p] of catalogPathsIn(list)) paths.set(r, p);
      for (const link of linksUnder(list, h.past_list)) {
        const page = await get(link.startsWith("http") ? link : base + link);
        if (page) for (const [r, p] of catalogPathsIn(page)) paths.set(r, p);
      }
    }
  }
  return paths;
}

async function collectCatalog(h, ref, pth) {
  const base = `https://${apiHost(h)}`;
  const meta = await get(`${base}/api/auctions/catalog/${ref}`, { json: true });
  if (!meta) return "no-meta";
  const cat = {
    ref, houseKey: h.key, path: pth, title: meta.catalogTitle, isLive: !!meta.isLive, isTimed: !!meta.isTimed,
    resultsIncludePremium: !!meta.resultsIncludePremium, premiumRate: schedulePremium(meta), currency: meta.currencyCode ?? meta.currency ?? null,
    eventDateLocal: (meta.eventLocalDateIso8601 ?? "").slice(0, 10) || null, eventTsUtc: (meta.eventDateIso8601 ?? "").replace(/\[.*$/, "") || null,
  };
  if (meta.isUpcoming || meta.inProgress) { await upsertCatalog(pool, { ...cat, status: "upcoming" }); return "upcoming"; }
  const html = await get(`${base}/${pth}`);
  const p1 = html ? pageOne(html) : null;
  if (!p1?.nbHits || !p1.ids.length) { await upsertCatalog(pool, { ...cat, status: "no-page" }); return "no-page"; }
  await upsertCatalog(pool, { ...cat, nbLots: p1.nbHits, status: "pending" });

  const found = new Map();
  const probe = async (id) => {
    const j = await get(`${base}/api/auctions/lot/${id}`, { json: true });
    const v = j?.itemView;
    if (!v || v.catalogRef !== ref) return false;
    found.set(v.ref, v); return true;
  };
  for (const id of p1.ids) await probe(id);
  const lo = Math.min(...p1.ids), hi = Math.max(...p1.ids);
  // Two-stage sweep: the block is contiguous with small gaps (withdrawn lots, other
  // catalogs' ids interleaved), so a short miss-run ends the cheap pass; if lots are
  // still missing, a second pass pushes each edge out by up to nbHits more ids.
  const edge = { 1: hi + 1, [-1]: lo - 1 };
  for (const missRun of [MISS_RUN, MISS_RUN * 3]) {
    for (const dir of [1, -1]) {
      let id = edge[dir], misses = 0, steps = 0;
      while (found.size < p1.nbHits && misses < missRun && steps < p1.nbHits + 100) { if (await probe(id)) misses = 0; else misses++; id += dir; steps++; }
      edge[dir] = id;
    }
    if (found.size >= p1.nbHits) break;
  }
  const rows = [...found.values()].map((v) => {
    const d = deriveLot(v, cat);
    return {
      lot_ref: v.ref, lot_id: v.lotId ?? null, catalog_ref: ref, lot_number: String(v.lotNumber ?? "") + (v.lotNumberExtension ?? ""),
      title: (v.title ?? "").slice(0, 400), category: v.categoryName ?? v.category ?? null, subcategory: v.subcategoryName ?? null,
      estimate_low: Number(v.estimateLow) || null, estimate_high: Number(v.estimateHigh) || null, is_sold: !!v.isSold, is_passed: !!v.isPassed,
      price_result: Number(v.priceResult) || null, premium_rate: d.rate, hammer: d.hammer, online_all_in: d.onlineAllIn || null, online_hammer: d.onlineHammer || null,
      bid_count: Number(v.bidCount) || 0, online_won: d.onlineWon, currency: v.currency ?? cat.currency ?? null,
    };
  });
  await upsertLots(pool, rows);
  const status = found.size >= p1.nbHits ? "complete" : "partial";
  await upsertCatalog(pool, { ...cat, nbLots: p1.nbHits, lotsFetched: found.size, status });
  lotsWritten += rows.length;
  const sold = rows.filter((r) => r.is_sold), thv = sold.reduce((s, r) => s + (r.hammer ?? 0), 0), online = sold.filter((r) => r.online_won).reduce((s, r) => s + (r.hammer ?? 0), 0);
  console.log(`  ${ref} ${cat.eventDateLocal} ${cat.isTimed ? "timed" : "live "} "${(cat.title ?? "").slice(0, 32)}" lots ${found.size}/${p1.nbHits} ${status} | THV ${fmtM(thv)} online ${fmtM(online)} (${thv ? ((online / thv) * 100).toFixed(1) : "0"}%)`);
  return status;
}

if (!flag("--summary-only")) {
  for (const h of houses) {
    await upsertHouse(pool, h);
    const paths = await discover(h);
    const done = flag("--refresh") ? new Set() : await completeRefs(pool, h.key);
    const todo = [...paths].filter(([r]) => !done.has(r)).slice(0, MAX);
    console.log(`${h.key}: ${paths.size} catalogs discovered, ${done.size} already complete, collecting ${todo.length}`);
    for (const [ref, pth] of todo) {
      try { const s = await collectCatalog(h, ref, pth); if (s === "complete" || s === "partial") catalogsDone++; }
      catch (e) { console.error(`  ${ref} failed: ${e.message}`); if (/blocked|bot challenge/.test(e.message)) break; }
    }
  }
  console.log(`done: ${catalogsDone} catalogs, ${lotsWritten} lots, ${stats.requests} requests (${stats.retries} retries)`);
}
const rows = await monthlySummary(pool, opt("--house"));
console.log("\nmonth       house     cats  lots  sold      THV   online  share  timed");
for (const r of rows) console.log(`${new Date(r.month).toISOString().slice(0, 7)}  ${String(r.house_key).padEnd(9)} ${String(r.catalogs).padStart(4)} ${String(r.lots).padStart(5)} ${String(r.sold).padStart(5)} ${fmtM(r.thv).padStart(9)} ${fmtM(r.online_won).padStart(8)} ${(r.thv ? (r.online_won / r.thv) * 100 : 0).toFixed(1).padStart(5)}% ${fmtM(r.thv_timed).padStart(8)}`);
await pool.close();
