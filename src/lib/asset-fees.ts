import "server-only";

import { randomUUID } from "node:crypto";
import { MAESTRO_URL, MAESTRO_KEY } from "./maestro";
import type { TopSoldLot } from "./azure-sql";

// Per-asset detail enrichment from Maestro (the same endpoints the AllSurplus web
// app calls on an asset page — NOT exposed by the bulk search/sold feeds):
//   POST /assets/{assetId}/{accountId}/assetadditionalfees -> { adminFeePercent, ... }
//   GET  /assets/{assetId}/{accountId}/bidwatchcount        -> integer watch count
// adminFeePercent is LQDT's admin (seller) fee % — a per-seller contracted rate,
// empirically constant per accountId and independent of the auction date/id — so we
// cache it per seller. Watch count is per-asset. These are one HTTP call each, so
// callers enrich only a bounded set (top lots), best-effort.

const OK_TTL = Number(process.env.ASSET_FEE_TTL_MS) || 24 * 60 * 60_000; // cache successful values a day
const NEG_TTL = 10 * 60_000; // cache failures only briefly, so a transient Maestro error doesn't hide a lot's data all day

type Cell = { v: number | null; at: number };
const feeCache = new Map<string, Cell>(); // key: site:accountId
const watchCache = new Map<string, Cell>(); // key: assetId:accountId
const feeInflight = new Map<string, Promise<number | null>>();
const watchInflight = new Map<string, Promise<number | null>>();

function fresh(cell: Cell | undefined): boolean {
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

/** LQDT admin (seller) fee % for a lot's seller. Cached per (site, accountId). null on failure. */
export async function fetchAdminFeePercent(
  site: string,
  assetId: string,
  accountId: string,
  auctionId: string,
  endDateEt: string,
  timeoutMs = 8_000,
  force = false,
): Promise<number | null> {
  if (!assetId || !accountId) return null;
  const key = `${site}:${accountId}`;
  // force skips the read cache (used by the cron, whose 8s budget shouldn't inherit a
  // transient null a short dashboard call may have cached); it still writes its result.
  if (!force) {
    const hit = feeCache.get(key);
    if (fresh(hit)) return hit!.v;
  }
  const running = feeInflight.get(key);
  if (running) return running;
  const p = (async () => {
    const res = await detailFetch(
      `/assets/${assetId}/${accountId}/assetadditionalfees`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetAuctionEndDate: endDateEt ? `${endDateEt}T00:00:00` : null,
          auctionId: auctionId || null,
          includeShipping: false,
          excludeAdminFees: false,
        }),
      },
      timeoutMs,
    );
    let pct: number | null = null;
    if (res?.ok) {
      try {
        const d = (await res.json()) as { adminFeePercent?: unknown };
        if (typeof d?.adminFeePercent === "number" && Number.isFinite(d.adminFeePercent)) pct = d.adminFeePercent;
      } catch {
        /* leave null */
      }
    }
    feeCache.set(key, { v: pct, at: Date.now() });
    return pct;
  })();
  feeInflight.set(key, p);
  try {
    return await p;
  } finally {
    feeInflight.delete(key);
  }
}

/** Final watch count for an asset. Cached per asset. null on failure or empty body. */
export async function fetchWatchCount(assetId: string, accountId: string, timeoutMs = 8_000): Promise<number | null> {
  if (!assetId || !accountId) return null;
  const key = `${assetId}:${accountId}`;
  const hit = watchCache.get(key);
  if (fresh(hit)) return hit!.v;
  const running = watchInflight.get(key);
  if (running) return running;
  const p = (async () => {
    const res = await detailFetch(`/assets/${assetId}/${accountId}/bidwatchcount`, { method: "GET" }, timeoutMs);
    let n: number | null = null;
    if (res?.ok) {
      try {
        const t = (await res.text()).trim();
        if (t) {
          const v = Number(t);
          if (Number.isFinite(v)) n = v; // empty/whitespace body stays null (not a spurious 0)
        }
      } catch {
        /* leave null */
      }
    }
    watchCache.set(key, { v: n, at: Date.now() });
    return n;
  })();
  watchInflight.set(key, p);
  try {
    return await p;
  } finally {
    watchInflight.delete(key);
  }
}

export type EnrichedLot = TopSoldLot & { admin_fee_percent: number | null; watch_count: number | null };

/**
 * Attach admin-fee take rate + watch count to each lot, best-effort. Bounded
 * concurrency + an overall deadline; each fetch's timeout is clamped to the
 * remaining budget so the whole call returns within ~deadlineMs even when Maestro
 * hangs. Unresolved lots keep null ("—"). Callers should render this behind a
 * Suspense boundary so it never blocks the rest of the page.
 */
export async function enrichTopLots(
  lots: TopSoldLot[],
  { concurrency = 8, deadlineMs = 10_000 }: { concurrency?: number; deadlineMs?: number } = {},
): Promise<EnrichedLot[]> {
  const out: EnrichedLot[] = lots.map((l) => ({ ...l, admin_fee_percent: null, watch_count: null }));
  const deadline = Date.now() + deadlineMs;
  let next = 0;
  async function worker() {
    while (next < lots.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 250) break; // not enough budget left to be worth a call
      const i = next++;
      const l = lots[i];
      const to = Math.min(6_000, remaining);
      const [pct, watch] = await Promise.all([
        fetchAdminFeePercent(l.site, l.asset_id, l.account_id, l.auction_id, l.close_date_et, to),
        fetchWatchCount(l.asset_id, l.account_id, to),
      ]);
      out[i].admin_fee_percent = pct;
      out[i].watch_count = watch;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, lots.length) }, worker));
  return out;
}
