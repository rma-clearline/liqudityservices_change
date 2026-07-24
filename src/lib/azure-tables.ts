// Azure SQL access layer for the app's relational tables (the Supabase→Azure
// migration — docs/azure-migration-spec.md). SERVER-ONLY. Reuses the lqdt_app
// pool + conventions from azure-sql.ts. Every function here mirrors the shape a
// Supabase read/write returned, so the callers (behind the DATA_BACKEND flag)
// are drop-in. jsonb columns are NVARCHAR(MAX) here, so JSON is parsed/stringified
// explicitly at this boundary; DATETIME2 columns come back as JS Dates and are
// converted to the ISO strings the app's row types expect.
import "server-only";
import sql from "mssql";
import { getPool } from "./azure-sql";
import type {
  ListingRow,
  FederalContractRow,
  ContractSnapshotRow,
  SamOpportunityRow,
  StateContractRow,
  MarketplaceSellerRow,
  SellerDeltaRow,
} from "./supabase";

// --- boundary helpers -------------------------------------------------------
/** DATETIME2/DATETIMEOFFSET → ISO string (matches PostgREST's timestamptz text). */
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
/** DATE → YYYY-MM-DD (the app compares these as plain date strings). */
function dateOnly(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "object") return v as T; // already parsed (defensive)
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return null;
  }
}
/** Clamp a caller-supplied row limit to a safe positive integer for a TOP clause. */
function top(n: number | undefined, fallback: number): number {
  const v = Math.floor(Number(n ?? fallback));
  return v > 0 && Number.isFinite(v) ? v : fallback;
}

/** Postgres `ORDER BY <col> DESC` sorts NULLs FIRST; SQL Server sorts them LAST.
 *  Emulate the Postgres order so a nullable-column DESC read returns rows in the
 *  same sequence the Supabase path did (matters under TOP/limit — a different set
 *  of rows would otherwise be shown). `col` is a fixed identifier, never input. */
function descNullsFirst(col: string): string {
  return `CASE WHEN ${col} IS NULL THEN 0 ELSE 1 END, ${col} DESC`;
}

// --- listings ---------------------------------------------------------------
export async function azFetchListings(opts: { sinceDate?: string; limit?: number } = {}): Promise<ListingRow[]> {
  const pool = await getPool();
  const req = pool.request();
  const where = opts.sinceDate ? "WHERE date >= @since" : "";
  if (opts.sinceDate) req.input("since", sql.NVarChar(10), opts.sinceDate);
  const topClause = opts.limit ? `TOP (${top(opts.limit, 30)}) ` : "";
  const res = await req.query(
    `SELECT ${topClause}id, date, timestamp, allsurplus, govdeals, created_at ` +
      `FROM lqdt.listings ${where} ORDER BY date DESC, ${descNullsFirst("timestamp")}`,
  );
  return res.recordset.map((r) => ({
    id: Number(r.id),
    date: r.date,
    timestamp: r.timestamp,
    // Pass NULLs through (like the Supabase read) rather than coercing to 0.
    allsurplus: num(r.allsurplus) as number,
    govdeals: num(r.govdeals) as number,
    created_at: iso(r.created_at) as string,
  }));
}

export async function azUpsertListing(v: {
  date: string;
  timestamp: string;
  allsurplus: number | null;
  govdeals: number | null;
}): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("date", sql.NVarChar(10), v.date)
    .input("timestamp", sql.NVarChar(8), v.timestamp)
    .input("allsurplus", sql.Int, v.allsurplus)
    .input("govdeals", sql.Int, v.govdeals)
    .query(
      "MERGE lqdt.listings WITH (HOLDLOCK) AS t " +
        "USING (SELECT @date AS date) AS s ON t.date = s.date " +
        "WHEN MATCHED THEN UPDATE SET timestamp = @timestamp, allsurplus = @allsurplus, govdeals = @govdeals " +
        "WHEN NOT MATCHED THEN INSERT (date, timestamp, allsurplus, govdeals) " +
        "VALUES (@date, @timestamp, @allsurplus, @govdeals);",
    );
}

// --- contracts page reads ---------------------------------------------------
export async function azFetchFederalContracts(limit = 20): Promise<FederalContractRow[]> {
  const pool = await getPool();
  const res = await pool.request().query(
    `SELECT TOP (${top(limit, 20)}) * FROM lqdt.federal_contracts ORDER BY ${descNullsFirst("start_date")}`,
  );
  return res.recordset.map((r) => ({
    ...(r as unknown as FederalContractRow),
    id: Number(r.id),
    award_amount: num(r.award_amount),
    total_obligation: num(r.total_obligation),
    created_at: iso(r.created_at) as string,
  }));
}

export async function azFetchLatestContractSnapshot(): Promise<ContractSnapshotRow | null> {
  const pool = await getPool();
  const res = await pool.request().query("SELECT TOP (1) * FROM lqdt.contract_snapshots ORDER BY date DESC");
  const r = res.recordset[0];
  if (!r) return null;
  return {
    ...(r as unknown as ContractSnapshotRow),
    id: Number(r.id),
    total_obligated_amount: num(r.total_obligated_amount),
    new_obligation_last_30d: num(r.new_obligation_last_30d),
    top_agencies: parseJson<ContractSnapshotRow["top_agencies"]>(r.top_agencies),
    created_at: iso(r.created_at) as string,
  };
}

export async function azFetchSamOpportunities(limit = 100): Promise<SamOpportunityRow[]> {
  const pool = await getPool();
  const res = await pool.request().query(
    `SELECT TOP (${top(limit, 100)}) * FROM lqdt.sam_opportunities ORDER BY ${descNullsFirst("posted_date")}`,
  );
  return res.recordset.map((r) => ({
    ...(r as unknown as SamOpportunityRow),
    id: Number(r.id),
    award_amount: num(r.award_amount),
    created_at: iso(r.created_at) as string,
  }));
}

const STATE_COLS =
  "id, state_code, source_portal, source_dataset_id, contract_id, vendor_name, vendor_normalized, " +
  "customer_agency, contract_title, amount, year, quarter, period_start, period_end, record_type, " +
  "source_query, first_seen_date, last_seen_date, created_at";

export async function azFetchStateContracts(limit = 200): Promise<StateContractRow[]> {
  const pool = await getPool();
  const res = await pool.request().query(
    `SELECT TOP (${top(limit, 200)}) ${STATE_COLS} FROM lqdt.state_contracts ORDER BY year DESC, quarter DESC`,
  );
  return res.recordset.map((r) => ({
    ...(r as unknown as StateContractRow),
    id: Number(r.id),
    amount: num(r.amount),
    period_start: dateOnly(r.period_start),
    period_end: dateOnly(r.period_end),
    raw_data: null,
    created_at: iso(r.created_at) as string,
  }));
}

export async function azLatestSellerSnapshot(): Promise<{ date: string | null; sellers: MarketplaceSellerRow[] }> {
  const pool = await getPool();
  const latest = await pool.request().query("SELECT TOP (1) date FROM lqdt.marketplace_sellers ORDER BY date DESC");
  const date = latest.recordset[0]?.date ?? null;
  if (!date) return { date: null, sellers: [] };
  const rows = await pool
    .request()
    .input("date", sql.NVarChar(10), date)
    .query("SELECT * FROM lqdt.marketplace_sellers WHERE date = @date");
  return { date, sellers: rows.recordset.map(mapSeller) };
}

// --- marketplace page reads -------------------------------------------------
function mapSeller(r: Record<string, unknown>): MarketplaceSellerRow {
  return {
    ...(r as unknown as MarketplaceSellerRow),
    id: Number(r.id),
    listing_count: num(r.listing_count),
    total_current_bid: num(r.total_current_bid),
    total_bids: num(r.total_bids),
    created_at: iso(r.created_at) as string,
  };
}

export async function azFetchMarketplaceSellers(limit = 200): Promise<MarketplaceSellerRow[]> {
  const pool = await getPool();
  const res = await pool.request().query(
    `SELECT TOP (${top(limit, 200)}) * FROM lqdt.marketplace_sellers ORDER BY date DESC, ${descNullsFirst("total_current_bid")}`,
  );
  return res.recordset.map(mapSeller);
}

// Inlines the Supabase marketplace_seller_deltas view (migration 019): compares
// each platform's two most-recent snapshots. TOP bounds the result like the
// old .limit(500).
const DELTAS_SQL = `
WITH ranked_dates AS (
  SELECT platform, date, ROW_NUMBER() OVER (PARTITION BY platform ORDER BY date DESC) AS rn
  FROM (SELECT DISTINCT platform, date FROM lqdt.marketplace_sellers) d
),
latest   AS (SELECT platform, date FROM ranked_dates WHERE rn = 1),
previous AS (SELECT platform, date FROM ranked_dates WHERE rn = 2),
cur AS (
  SELECT s.platform, s.account_id, s.company_name, s.country, s.state,
         s.listing_count, s.total_current_bid, s.total_bids, s.date
  FROM lqdt.marketplace_sellers s JOIN latest l ON s.platform = l.platform AND s.date = l.date
),
pr AS (
  SELECT s.platform, s.account_id, s.listing_count AS prev_listing_count,
         s.total_current_bid AS prev_total_current_bid, s.date AS prev_date
  FROM lqdt.marketplace_sellers s JOIN previous p ON s.platform = p.platform AND s.date = p.date
)
SELECT TOP (500)
  COALESCE(cur.platform, pr.platform)     AS platform,
  COALESCE(cur.account_id, pr.account_id) AS account_id,
  cur.company_name, cur.country, cur.state,
  cur.date AS snapshot_date, pr.prev_date,
  cur.listing_count, pr.prev_listing_count,
  COALESCE(cur.listing_count,0) - COALESCE(pr.prev_listing_count,0)         AS listing_count_delta,
  cur.total_current_bid, pr.prev_total_current_bid,
  COALESCE(cur.total_current_bid,0) - COALESCE(pr.prev_total_current_bid,0) AS gmv_delta,
  CAST(CASE WHEN pr.account_id IS NULL THEN 1 ELSE 0 END AS BIT) AS is_new,
  CAST(CASE WHEN cur.account_id IS NULL THEN 1 ELSE 0 END AS BIT) AS disappeared
FROM cur FULL OUTER JOIN pr ON cur.platform = pr.platform AND cur.account_id = pr.account_id`;

export async function azFetchSellerDeltas(): Promise<SellerDeltaRow[]> {
  const pool = await getPool();
  const res = await pool.request().query(DELTAS_SQL);
  return res.recordset.map((r) => ({
    ...(r as unknown as SellerDeltaRow),
    listing_count: num(r.listing_count),
    prev_listing_count: num(r.prev_listing_count),
    listing_count_delta: num(r.listing_count_delta),
    total_current_bid: num(r.total_current_bid),
    prev_total_current_bid: num(r.prev_total_current_bid),
    gmv_delta: num(r.gmv_delta),
    is_new: r.is_new === true || r.is_new === 1,
    disappeared: r.disappeared === true || r.disappeared === 1,
  }));
}

// --- data-status ------------------------------------------------------------
/** Composite freshness (mirrors the latest_data_freshness RPC). */
export async function azFetchDataFreshness(): Promise<Record<string, string | null>> {
  const pool = await getPool();
  const res = await pool.request().query(
    "SELECT " +
      "(SELECT MAX(date) FROM lqdt.listings) AS listings, " +
      "(SELECT MAX(date) FROM lqdt.marketplace_sellers) AS marketplace_sellers, " +
      "(SELECT MAX(last_seen_at) FROM lqdt.auctions) AS auctions, " +
      "(SELECT MAX(first_seen_date) FROM lqdt.federal_contracts) AS federal_contracts, " +
      "(SELECT MAX(date) FROM lqdt.contract_snapshots) AS contract_snapshots, " +
      "(SELECT MAX(first_seen_date) FROM lqdt.sam_opportunities) AS sam_opportunities, " +
      // Return the two state_contracts freshness sources separately and COALESCE in
      // JS, so the fallback stays a plain YYYY-MM-DD string (matching the Supabase
      // RPC) instead of being widened to a datetime2.
      "(SELECT MAX(ended_at) FROM lqdt.cron_runs WHERE source = 'state_contracts' AND status IN ('success','partial')) AS state_ended_at, " +
      "(SELECT MAX(COALESCE(last_seen_date, first_seen_date)) FROM lqdt.state_contracts) AS state_date",
  );
  const r = res.recordset[0] ?? {};
  return {
    listings: r.listings ?? null,
    marketplace_sellers: r.marketplace_sellers ?? null,
    auctions: iso(r.auctions),
    federal_contracts: r.federal_contracts ?? null,
    contract_snapshots: r.contract_snapshots ?? null,
    sam_opportunities: r.sam_opportunities ?? null,
    state_contracts: r.state_ended_at != null ? iso(r.state_ended_at) : (r.state_date ?? null),
  };
}

export type AzCronRunRow = {
  run_id: string;
  source: string;
  status: string;
  rows_ingested: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
};

export async function azFetchCronRunsRecent(limit = 60): Promise<AzCronRunRow[]> {
  const pool = await getPool();
  const res = await pool.request().query(
    `SELECT TOP (${top(limit, 60)}) run_id, source, status, rows_ingested, error, started_at, ended_at, duration_ms ` +
      `FROM lqdt.cron_runs ORDER BY started_at DESC`,
  );
  return res.recordset.map((r) => ({
    // mssql returns UNIQUEIDENTIFIER uppercase; PostgREST returns uuid lowercase.
    run_id: String(r.run_id).toLowerCase(),
    source: String(r.source),
    status: String(r.status),
    rows_ingested: num(r.rows_ingested),
    error: r.error ?? null,
    started_at: iso(r.started_at) as string,
    ended_at: iso(r.ended_at),
    duration_ms: num(r.duration_ms),
  }));
}

// --- forecast snapshot + report headline ------------------------------------
export async function azFetchLatestForecastSnapshot<T>(quarter?: string): Promise<{ quarter: string; payload: T; generated_at: string } | null> {
  const pool = await getPool();
  const req = pool.request();
  let q = "SELECT TOP (1) quarter, payload, generated_at FROM lqdt.forecast_snapshots ";
  if (quarter) {
    req.input("q", sql.NVarChar(16), quarter);
    q += "WHERE quarter = @q ";
  }
  q += "ORDER BY generated_at DESC";
  const res = await req.query(q);
  const r = res.recordset[0];
  if (!r) return null;
  const payload = parseJson<T>(r.payload);
  if (payload == null) return null;
  return { quarter: r.quarter, payload, generated_at: iso(r.generated_at) as string };
}

/** cron_runs 'email' rows (newest first) for the report's "since last report". */
export async function azFetchRecentEmailRuns(limit = 10): Promise<{ detail: unknown; started_at: string }[]> {
  const pool = await getPool();
  const res = await pool.request().query(
    `SELECT TOP (${top(limit, 10)}) detail, started_at FROM lqdt.cron_runs ` +
      `WHERE source = 'email' AND status = 'success' ORDER BY started_at DESC`,
  );
  return res.recordset.map((r) => ({ detail: parseJson<unknown>(r.detail), started_at: iso(r.started_at) as string }));
}
