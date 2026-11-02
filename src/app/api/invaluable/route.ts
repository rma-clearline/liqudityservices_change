import { NextResponse } from "next/server";
import { getPool, isAzureSqlConfigured } from "@/lib/azure-sql";
import { ttlCache } from "@/lib/cache";
import { rollupPeriods, rollupRowsFromDb } from "@/lib/invaluable-series";

export const dynamic = "force-dynamic";

/** One period of the Invaluable panel GMS proxy (USD). online_usd = hammer of lots
 *  inferred as won through the platform, which is Invaluable's GMS definition. */
export type InvaluablePeriod = {
  period: string; // YYYY-MM or YYYYQn
  houses: number;
  sold: number;
  thv_usd: number;
  online_usd: number;
  online_lots: number;
  /** Equality test without the bid-count guard: an upper bound on online-won. */
  online_loose_usd: number;
  timed_usd: number;
};

/** One house in one period, for like-for-like growth on the client. */
export type InvaluableHousePeriod = { period: string; house: string; thv_usd: number; online_usd: number };

/** Collection coverage, for the page's provenance line. */
export type InvaluableMeta = { catalogs: number; lots: number; collected_through: string | null; fetched_at: string | null };

export type InvaluablePayload = {
  month: InvaluablePeriod[];
  quarter: InvaluablePeriod[];
  houses: string[];
  houseNames: Record<string, string>;
  byHouse: { month: InvaluableHousePeriod[]; quarter: InvaluableHousePeriod[] };
  meta: InvaluableMeta;
};

const cache = ttlCache<InvaluablePayload>(Number(process.env.INVALUABLE_CACHE_MS) || 15 * 60_000);

// The per-house, per-month aggregate is pre-computed into lqdt.inv_house_month by the
// collector (scripts/invaluable/db.mjs refreshRollup) after each run, so the page no
// longer scans ~240k lots on a cold cache (that saturated the shared S2 DB and timed
// out). We read the few hundred rollup rows and roll months into quarters in code.
const ROLLUP_SQL =
  "SELECT house_key, month, sold, thv_usd, online_usd, online_lots, online_loose_usd, timed_usd FROM lqdt.inv_house_month ORDER BY month, house_key";

async function load(): Promise<InvaluablePayload> {
  const pool = await getPool();
  const num = (v: unknown) => Number(v) || 0;
  const [rows, houseList, metaRow] = await Promise.all([
    pool.request().query(ROLLUP_SQL).then((r) => rollupRowsFromDb(r.recordset as Record<string, unknown>[])),
    pool.request().query("SELECT house_key, name FROM lqdt.inv_houses ORDER BY house_key").then((r) => r.recordset as { house_key: string; name: string | null }[]),
    pool
      .request()
      .query(
        "SELECT COUNT(*) AS catalogs, SUM(lots_fetched) AS lots, MAX(event_date_local) AS last_event, MAX(fetched_at) AS fetched_at" +
          " FROM lqdt.inv_catalogs WHERE status IN ('complete','partial') AND lots_fetched >= 0.9 * nb_lots",
      )
      .then((r) => (r.recordset[0] ?? {}) as Record<string, unknown>),
  ]);
  const { month, quarter, byHouse } = rollupPeriods(rows);
  const houses = houseList.map((h) => h.house_key);
  const houseNames = Object.fromEntries(houseList.map((h) => [h.house_key, h.name || h.house_key]));
  const dateKey = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  const meta: InvaluableMeta = { catalogs: num(metaRow.catalogs), lots: num(metaRow.lots), collected_through: dateKey(metaRow.last_event), fetched_at: iso(metaRow.fetched_at) };
  return { month, quarter, houses, houseNames, byHouse, meta };
}

export async function GET() {
  if (!isAzureSqlConfigured()) return NextResponse.json({ error: "store not configured" }, { status: 503 });
  try {
    const data = await cache.get("all", load);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
