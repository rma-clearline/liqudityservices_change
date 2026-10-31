import { NextResponse } from "next/server";
import { getPool, isAzureSqlConfigured } from "@/lib/azure-sql";
import { ttlCache } from "@/lib/cache";
import { rollupPeriods, type HouseMonthRow } from "@/lib/invaluable-series";

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

// One scan, per house and month, with the report script's filter and FX (catalogs
// >= 90% collected; native hammer at the sale-day rate; fx_rates stores units per
// USD). Quarters, panel totals and per-house rows are rolled up in code
// (rollupPeriods), which cut the cold load from four scans to one.
const HOUSE_MONTH_SQL =
  "WITH lots AS (" +
  "  SELECT c.house_key, CONVERT(char(7), c.event_date_local, 126) AS month, c.is_timed, l.is_sold, l.online_won, l.hammer, l.online_hammer, ISNULL(l.currency, 'USD') AS currency, c.event_date_local" +
  "  FROM lqdt.inv_catalogs c JOIN lqdt.inv_lots l ON l.catalog_ref = c.catalog_ref" +
  "  WHERE c.status IN ('complete','partial') AND c.lots_fetched >= 0.9 * c.nb_lots" +
  "), fx AS (" +
  "  SELECT lots.*, CASE WHEN currency = 'USD' THEN 1.0 ELSE (" +
  "    SELECT TOP (1) usd_per_unit FROM lqdt.fx_rates f WHERE f.currency = lots.currency AND f.date <= CONVERT(char(10), lots.event_date_local, 126) ORDER BY f.date DESC) END AS units_per_usd" +
  "  FROM lots" +
  ") SELECT house_key, month," +
  "  SUM(CASE WHEN is_sold = 1 THEN 1 ELSE 0 END) AS sold," +
  "  SUM(CASE WHEN is_sold = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS thv_usd," +
  "  SUM(CASE WHEN online_won = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS online_usd," +
  "  SUM(CASE WHEN online_won = 1 THEN 1 ELSE 0 END) AS online_lots," +
  "  SUM(CASE WHEN is_sold = 1 AND ABS(ISNULL(online_hammer,0) - ISNULL(hammer,0)) <= CASE WHEN hammer * 0.005 > 1 THEN hammer * 0.005 ELSE 1 END THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS online_loose_usd," +
  "  SUM(CASE WHEN is_timed = 1 AND is_sold = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS timed_usd" +
  " FROM fx GROUP BY house_key, month ORDER BY month, house_key";

async function load(): Promise<InvaluablePayload> {
  const pool = await getPool();
  const num = (v: unknown) => Number(v) || 0;
  const [rows, houseList, metaRow] = await Promise.all([
    pool.request().query(HOUSE_MONTH_SQL).then((r) =>
      r.recordset.map(
        (x: Record<string, unknown>): HouseMonthRow => ({
          house: String(x.house_key),
          month: String(x.month),
          sold: num(x.sold),
          thv_usd: num(x.thv_usd),
          online_usd: num(x.online_usd),
          online_lots: num(x.online_lots),
          online_loose_usd: num(x.online_loose_usd),
          timed_usd: num(x.timed_usd),
        }),
      ),
    ),
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
