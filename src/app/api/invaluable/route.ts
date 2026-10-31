import { NextResponse } from "next/server";
import { getPool, isAzureSqlConfigured } from "@/lib/azure-sql";
import { ttlCache } from "@/lib/cache";

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

const cache = ttlCache<{ month: InvaluablePeriod[]; quarter: InvaluablePeriod[]; houses: string[]; byHouse: { month: InvaluableHousePeriod[]; quarter: InvaluableHousePeriod[] } }>(
  Number(process.env.INVALUABLE_CACHE_MS) || 15 * 60_000,
);

// Same query as scripts/invaluable-report.mjs: catalogs >= 90% collected, native
// hammer converted with the sale-day FX rate (fx_rates stores units per USD).
function periodSql(grain: "month" | "quarter"): string {
  const periodExpr =
    grain === "quarter"
      ? "CONCAT(YEAR(c.event_date_local), 'Q', DATEPART(quarter, c.event_date_local))"
      : "CONVERT(char(7), c.event_date_local, 126)";
  return (
    "WITH lots AS (" +
    "  SELECT c.house_key, " + periodExpr + " AS period, c.is_timed, l.is_sold, l.online_won, l.hammer, l.online_hammer, ISNULL(l.currency, 'USD') AS currency, c.event_date_local" +
    "  FROM lqdt.inv_catalogs c JOIN lqdt.inv_lots l ON l.catalog_ref = c.catalog_ref" +
    "  WHERE c.status IN ('complete','partial') AND c.lots_fetched >= 0.9 * c.nb_lots" +
    "), fx AS (" +
    "  SELECT lots.*, CASE WHEN currency = 'USD' THEN 1.0 ELSE (" +
    "    SELECT TOP (1) usd_per_unit FROM lqdt.fx_rates f WHERE f.currency = lots.currency AND f.date <= CONVERT(char(10), lots.event_date_local, 126) ORDER BY f.date DESC) END AS units_per_usd" +
    "  FROM lots" +
    ") SELECT period, COUNT(DISTINCT house_key) AS houses," +
    "  SUM(CASE WHEN is_sold = 1 THEN 1 ELSE 0 END) AS sold," +
    "  SUM(CASE WHEN is_sold = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS thv_usd," +
    "  SUM(CASE WHEN online_won = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS online_usd," +
    "  SUM(CASE WHEN online_won = 1 THEN 1 ELSE 0 END) AS online_lots," +
    "  SUM(CASE WHEN is_sold = 1 AND ABS(ISNULL(online_hammer,0) - ISNULL(hammer,0)) <= CASE WHEN hammer * 0.005 > 1 THEN hammer * 0.005 ELSE 1 END THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS online_loose_usd," +
    "  SUM(CASE WHEN is_timed = 1 AND is_sold = 1 THEN hammer / NULLIF(units_per_usd, 0) ELSE 0 END) AS timed_usd" +
    " FROM fx GROUP BY period ORDER BY period"
  );
}

async function load() {
  const pool = await getPool();
  const num = (v: unknown) => Number(v) || 0;
  const rows = (grain: "month" | "quarter") =>
    pool.request().query(periodSql(grain)).then((r) =>
      r.recordset.map((x: Record<string, unknown>): InvaluablePeriod => ({
        period: String(x.period),
        houses: num(x.houses),
        sold: num(x.sold),
        thv_usd: num(x.thv_usd),
        online_usd: num(x.online_usd),
        online_lots: num(x.online_lots),
        online_loose_usd: num(x.online_loose_usd),
        timed_usd: num(x.timed_usd),
      })),
    );
  const [month, quarter, houses] = await Promise.all([
    rows("month"),
    rows("quarter"),
    pool.request().query("SELECT house_key FROM lqdt.inv_houses ORDER BY house_key").then((r) => r.recordset.map((x: { house_key: string }) => x.house_key)),
  ]);
  // Per-house rows: the UI computes like-for-like Y/Y (houses present in both periods).
  const perHouse = (grain: "month" | "quarter") =>
    pool
      .request()
      .query(periodSql(grain).replace("SELECT period, COUNT(DISTINCT house_key) AS houses,", "SELECT period, house_key,").replace("GROUP BY period ORDER BY period", "GROUP BY period, house_key ORDER BY period, house_key"))
      .then((r) => r.recordset.map((x: Record<string, unknown>): InvaluableHousePeriod => ({ period: String(x.period), house: String(x.house_key), thv_usd: num(x.thv_usd), online_usd: num(x.online_usd) })));
  const [byHouseMonth, byHouseQuarter] = await Promise.all([perHouse("month"), perHouse("quarter")]);
  return { month, quarter, houses, byHouse: { month: byHouseMonth, quarter: byHouseQuarter } };
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
