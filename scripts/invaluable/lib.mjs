// Invaluable panel collector — HTTP (polite, identified, rate-limited), page parsing,
// and the per-lot derivations. Permission-based collection; see README section.
import { setTimeout as sleep } from "node:timers/promises";

// The WAF rejects non-browser UAs (HTTP 403), so this is browser-shaped but still
// names us and how to reach us.
export const UA = "Mozilla/5.0 (compatible; ClearlineCapital-InvaluableTracker/0.1; rma@clearlinecap.com; permitted)";
const MIN_GAP_MS = Number(process.env.INV_MIN_GAP_MS) || 500; // <= 2 requests/s per host
const lastAt = new Map();
const blocked = new Set();
export const stats = { requests: 0, retries: 0 };

/** GET with per-host spacing, backoff on 429/5xx, and a hard stop for a host that
 *  blocks us (403, or the empty-202 bot challenge). null = 404 / unparseable. */
export async function get(url, { json = false } = {}) {
  const host = new URL(url).host;
  if (blocked.has(host)) throw new Error(`host ${host} is blocked for this run`);
  // invaluable.com publishes Crawl-delay: 10; it is only ever asked for house pages.
  const gap = host.endsWith("invaluable.com") ? Math.max(MIN_GAP_MS, 10_000) : MIN_GAP_MS;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = (lastAt.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, Date.now());
    stats.requests++;
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/html" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt === 4) throw e;
      stats.retries++; await sleep(2_000 * attempt); continue;
    }
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 401) { blocked.add(host); throw new Error(`blocked by ${host} (HTTP ${res.status}) — stopping this host`); }
    if (res.status === 429 || res.status >= 500) { stats.retries++; await sleep(10_000 * attempt); continue; }
    const text = await res.text();
    if (!text) {
      if (res.status === 202) { blocked.add(host); throw new Error(`bot challenge from ${host} (empty 202) — stopping this host`); }
      if (attempt === 4) return null;
      stats.retries++; await sleep(2_000 * attempt); continue;
    }
    if (!json) return text;
    try { return JSON.parse(text); } catch { return null; }
  }
  return null;
}

/** Hosted-catalog paths on a page: { ref -> "auction-catalog/<slug>_<REF>" }. */
export function catalogPathsIn(html) {
  const out = new Map();
  for (const m of html.matchAll(/auction-catalog\/([A-Za-z0-9_-]+_([A-Z0-9]{10}))/g)) out.set(m[2], `auction-catalog/${m[1]}`);
  return out;
}
/** Same-site links under a prefix (the house's own past-sale pages). */
export function linksUnder(html, prefix) {
  // String scan rather than a built regex: the prefix is a URL path, and keeping
  // backslash escapes out of this file keeps it safe to regenerate via heredoc.
  const out = new Set();
  let i = 0;
  while ((i = html.indexOf('href="', i)) >= 0) {
    i += 6;
    const j = html.indexOf('"', i);
    if (j < 0) break;
    const href = html.slice(i, j);
    const pathPart = href.startsWith("http") ? href.slice(href.indexOf("/", 8)) : href;
    if (pathPart.startsWith(prefix) && pathPart.length > prefix.length && !pathPart.includes("#") && !pathPart.includes("?")) out.add(href);
    i = j;
  }
  return [...out];
}
/** Catalog page: search envelope + the first page's numeric lot ids (sweep anchors). */
export function pageOne(html) {
  const num = (k) => { const m = new RegExp('"' + k + '":([0-9]+)').exec(html); return m ? Number(m[1]) : null; };
  const ids = [...new Set([...html.matchAll(/"objectID":"(\d+)"/g)].map((m) => Number(m[1])))];
  return { nbHits: num("nbHits"), hitsPerPage: num("hitsPerPage"), ids };
}

/** Premium rate for a catalog: the house's schedule (first tier) as a fraction. */
export const schedulePremium = (meta) => {
  const p = meta?.groupModel?.buyersPremiums?.[0]?.premium;
  return Number.isFinite(Number(p)) && Number(p) > 0 ? Number(p) / 100 : null;
};

// --- premium-rate resolution ---------------------------------------------------
// Where a house posts results premium-inclusive, the hammer is result / (1 + rate),
// and the rate is NOT reliably known: the lot API's buyersPremium is a naive
// rate x result that can carry a different schedule from the one the results were
// computed with (Crescent City: 23% vs the 28% the results embed; Grogan: the
// reverse, the current 30% schedule vs the 25% in force at the sale). The right
// rate is the one under which results divide back to whole-dollar hammers (bids
// move in whole increments), chosen per lot among the candidates, with the
// catalog's dominant rate breaking ties.
const ROUND_TOL = 0.011;
const isWhole = (x) => Math.abs(x - Math.round(x)) < ROUND_TOL;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** Candidate rates for a catalog: the schedule first, then each distinct naive
 *  rate the lot records carry. */
export function rateCandidates(lots, cat) {
  const out = [];
  const add = (r) => {
    if (!Number.isFinite(r) || r <= 0) return;
    const v = r4(r);
    if (!out.some((x) => Math.abs(x - v) < 0.0005)) out.push(v);
  };
  add(Number(cat?.premiumRate));
  for (const v of lots) {
    const pr = Number(v.priceResult) || 0, bp = Number(v.buyersPremium) || 0;
    if (v.isSold && pr > 0 && bp > 0) add(bp / pr);
  }
  return out;
}

/** The candidate under which the most sold results are whole-dollar hammers;
 *  the first candidate when none is, null without candidates. */
export function dominantRate(results, candidates) {
  if (!candidates.length) return null;
  let best = candidates[0], bestN = -1;
  for (const r of candidates) {
    let n = 0;
    for (const pr of results) if (pr > 0 && isWhole(pr / (1 + r))) n++;
    if (n > bestN) { best = r; bestN = n; }
  }
  return best;
}

/** The one candidate that makes this result a whole-dollar hammer, else the dominant. */
export function lotRate(priceResult, candidates, dominant) {
  const whole = candidates.filter((r) => isWhole(priceResult / (1 + r)));
  return whole.length === 1 ? whole[0] : dominant;
}

/** Hammer from a posted result (to the cent). */
export function hammerOf(priceResult, rate, includePremium) {
  const h = includePremium && rate != null ? priceResult / (1 + rate) : priceResult;
  return Math.round(h * 100) / 100;
}

/** Won through the platform: timed sales by construction; live sales when the top
 *  online bid equals the hammer and at least one online bid was placed (with none,
 *  the online figure is the opening bid, which a floor buyer can pay exactly). */
export function onlineWon({ sold, hammer, onlineHammer, bids, isTimed }) {
  if (!sold || hammer == null || !(hammer > 0)) return false;
  if (isTimed) return true;
  return bids >= 1 && Math.abs(onlineHammer - hammer) <= Math.max(1, hammer * 0.005);
}

/** Resolved rates for a whole catalog (pass to deriveLot). */
export function catalogRates(lots, cat) {
  const candidates = rateCandidates(lots, cat);
  const results = lots.filter((v) => v.isSold).map((v) => Number(v.priceResult) || 0);
  return { candidates, dominant: dominantRate(results, candidates) };
}

/** Per-lot derivations from the lot API's itemView + catalog meta. Online bids are
 *  hammer-basis; posted results may include the premium (see above). `rates` from
 *  catalogRates() resolves the premium per lot; without it the naive lot rate is used. */
export function deriveLot(v, cat, rates = null) {
  const sold = !!v.isSold;
  const pr = Number(v.priceResult) || 0;
  const bp = Number(v.buyersPremium) || 0;
  const naive = sold && pr > 0 && bp > 0 ? bp / pr : cat.premiumRate;
  const rate = rates && sold && pr > 0 && cat.resultsIncludePremium ? lotRate(pr, rates.candidates, rates.dominant) : naive;
  const hammer = sold && pr > 0 ? hammerOf(pr, rate, !!cat.resultsIncludePremium) : null;
  // Top online bid: the catalog lots list gives it hammer-basis as `price`; the
  // per-lot API (fallback path) gives it premium-inclusive (currentBidAllIn).
  const hasAllIn = v.currentBidAllIn != null && Number.isFinite(Number(v.currentBidAllIn));
  const onlineAllIn = hasAllIn ? Number(v.currentBidAllIn) : (rate != null ? (Number(v.price) || 0) * (1 + rate) : Number(v.price) || 0);
  const onlineHammer = hasAllIn ? (rate != null ? onlineAllIn / (1 + rate) : onlineAllIn) : Number(v.price) || 0;
  const bids = Number(v.bidCount) || 0;
  return { rate, hammer, onlineAllIn, onlineHammer, onlineWon: onlineWon({ sold, hammer, onlineHammer, bids, isTimed: !!cat.isTimed }) };
}
