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

/** Per-lot derivations from the lot API's itemView + catalog meta.
 *  Online bids are hammer-basis; posted results may include the premium. A lot was
 *  won through the platform when the top online bid, premium-adjusted, equals the
 *  result (timed sales: every sold lot is online by construction). */
export function deriveLot(v, cat) {
  const sold = !!v.isSold;
  const pr = Number(v.priceResult) || 0;
  const bp = Number(v.buyersPremium) || 0;
  const rate = sold && pr > 0 && bp > 0 ? bp / pr : cat.premiumRate;
  const hammer = sold && pr > 0 ? (cat.resultsIncludePremium && rate != null ? pr / (1 + rate) : pr) : null;
  const onlineAllIn = Number(v.currentBidAllIn) || 0;
  const onlineHammer = rate != null ? onlineAllIn / (1 + rate) : onlineAllIn;
  const onlineWon = sold && hammer != null && hammer > 0
    ? (cat.isTimed ? true : Math.abs(onlineHammer - hammer) <= Math.max(1, hammer * 0.005))
    : false;
  return { rate, hammer, onlineAllIn, onlineHammer, onlineWon };
}
