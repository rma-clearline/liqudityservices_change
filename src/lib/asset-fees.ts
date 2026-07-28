import "server-only";

import { randomUUID } from "node:crypto";
import { MAESTRO_URL, MAESTRO_KEY } from "./maestro";
import type { TopSoldLot } from "./azure-sql";

// Per-asset detail enrichment from Maestro (the same call the AllSurplus/GovDeals web
// apps make for an asset's bid box — NOT exposed by the bulk search/sold feeds):
//   GET /bids/bidbox/{businessId}/{assetId}/{accountId}/{auctionId}
//     -> { premiumPercent, adminFeePercent, watcherCount, visitors, percentCharged, ... }
// premiumPercent is the BUYER's premium (buyer-paid, on top of the hammer) — event/seller
// set, so it varies by listing; adminFeePercent is LQDT's seller-side admin fee. Together
// they are the take-rate components; watcherCount/visitors are demand signals. It's a
// single anonymous call per lot, so callers enrich only a bounded set (top lots), best-effort.

const OK_TTL = Number(process.env.ASSET_FEE_TTL_MS) || 24 * 60 * 60_000; // cache successful values a day
const NEG_TTL = 10 * 60_000; // cache failures only briefly, so a transient Maestro error doesn't hide a lot's data all day

type Cell<T> = { v: T | null; at: number };
const bidboxCache = new Map<string, Cell<Bidbox>>(); // key: biz:assetId:accountId:auctionId
const bidboxInflight = new Map<string, Promise<Bidbox | null>>();

function fresh<T>(cell: Cell<T> | undefined): boolean {
  if (!cell) return false;
  return Date.now() - cell.at < (cell.v == null ? NEG_TTL : OK_TTL);
}

async function detailFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(`${MAESTRO_URL}${path}`, {
      ...init,
      headers: {
        "x-api-key": MAESTRO_KEY,
        "x-user-id": "-1",
        "x-api-correlation-id": randomUUID(),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Bid-box detail for one lot: buyer's premium + seller admin fee + demand signals. */
export type Bidbox = {
  premiumPercent: number | null; // buyer's premium % (buyer pays, on the hammer)
  adminFeePercent: number | null; // LQDT seller-side admin fee %
  watchCount: number | null;
  visitors: number | null;
};

/**
 * Bid-box detail for a lot: GET /bids/bidbox/{biz}/{assetId}/{accountId}/{auctionId}.
 * `biz` is the marketplace (site: AD/GD/GI). Cached per lot (premium varies by listing,
 * so this is NOT a per-seller cache); null on failure. `force` skips the read cache — the
 * cron's tight budget shouldn't inherit a transient null a dashboard call may have cached.
 */
export async function fetchBidbox(
  biz: string,
  assetId: string,
  accountId: string,
  auctionId: string,
  timeoutMs = 8_000,
  force = false,
): Promise<Bidbox | null> {
  if (!biz || !assetId || !accountId) return null;
  const auc = auctionId || "1";
  const key = `${biz}:${assetId}:${accountId}:${auc}`;
  if (!force) {
    const hit = bidboxCache.get(key);
    if (fresh(hit)) return hit!.v;
  }
  const running = bidboxInflight.get(key);
  if (running) return running;
  const p = (async () => {
    const res = await detailFetch(`/bids/bidbox/${biz}/${assetId}/${accountId}/${auc}`, { method: "GET" }, timeoutMs);
    let out: Bidbox | null = null;
    if (res?.ok) {
      try {
        const d = (await res.json()) as Record<string, unknown>;
        out = {
          premiumPercent: num(d.premiumPercent),
          adminFeePercent: num(d.adminFeePercent),
          watchCount: num(d.watcherCount),
          visitors: num(d.visitors),
        };
      } catch {
        out = null; // leave null → NEG_TTL retry
      }
    }
    bidboxCache.set(key, { v: out, at: Date.now() });
    return out;
  })();
  bidboxInflight.set(key, p);
  try {
    return await p;
  } finally {
    bidboxInflight.delete(key);
  }
}

export type EnrichedLot = TopSoldLot & {
  admin_fee_percent: number | null;
  buyer_premium_percent: number | null;
  watch_count: number | null;
  visitors: number | null;
};

/**
 * Attach bid-box detail (buyer premium + seller fee + watches + visitors) to each lot,
 * best-effort. Bounded concurrency + an overall deadline; each fetch's timeout is clamped
 * to the remaining budget so the whole call returns within ~deadlineMs even when Maestro
 * hangs. Unresolved lots keep null ("—"). Callers should render this behind a Suspense
 * boundary so it never blocks the rest of the page.
 */
export async function enrichTopLots(
  lots: TopSoldLot[],
  { concurrency = 8, deadlineMs = 10_000 }: { concurrency?: number; deadlineMs?: number } = {},
): Promise<EnrichedLot[]> {
  const out: EnrichedLot[] = lots.map((l) => ({
    ...l,
    admin_fee_percent: null,
    buyer_premium_percent: null,
    watch_count: null,
    visitors: null,
  }));
  const deadline = Date.now() + deadlineMs;
  let next = 0;
  async function worker() {
    while (next < lots.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 250) break; // not enough budget left to be worth a call
      const i = next++;
      const l = lots[i];
      const to = Math.min(6_000, remaining);
      const b = await fetchBidbox(l.site, l.asset_id, l.account_id, l.auction_id, to);
      if (b) {
        out[i].admin_fee_percent = b.adminFeePercent;
        out[i].buyer_premium_percent = b.premiumPercent;
        out[i].watch_count = b.watchCount;
        out[i].visitors = b.visitors;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, lots.length) }, worker));
  return out;
}
