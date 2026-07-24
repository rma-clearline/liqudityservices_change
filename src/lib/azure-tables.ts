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

// ===========================================================================
// Phase 1b — writes (cron ingestion) + the forecast's live-quarter auction reads
// ===========================================================================

/** Retry a MERGE/UPDATE on a deadlock (SQL error 1205), mirroring azure-sql.ts. */
async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      const n = (e as { number?: number; originalError?: { info?: { number?: number } } })?.number ??
        (e as { originalError?: { info?: { number?: number } } })?.originalError?.info?.number;
      if (n === 1205 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

/** Keep the LAST row per key (matches Postgres upsert "latest wins") so an
 *  in-batch duplicate key can't make a SQL Server MERGE touch a row twice (error
 *  8672 / a unique-violation on insert-only). Our batches are effectively unique
 *  already; this is a safety net. */
function dedupBy<T>(rows: readonly T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

type Col = [name: string, type: string];

function openJsonSchema(cols: Col[]): string {
  return cols.map(([n, t]) => `${n} ${t}`).join(", ");
}

/** MERGE-upsert `table` from a JSON row array: update non-key columns on match,
 *  insert otherwise. Identity/default columns (id, created_at, first_seen_at) are
 *  omitted so they keep their DEFAULT on insert and are untouched on update. */
function upsertMergeSql(table: string, cols: Col[], keyCols: string[]): string {
  const nonKey = cols.filter(([n]) => !keyCols.includes(n));
  const on = keyCols.map((k) => `t.${k} = s.${k}`).join(" AND ");
  const set = nonKey.map(([n]) => `${n} = s.${n}`).join(", ");
  const insCols = cols.map(([n]) => n).join(", ");
  const insVals = cols.map(([n]) => `s.${n}`).join(", ");
  return (
    `MERGE ${table} WITH (HOLDLOCK) AS t ` +
    `USING (SELECT * FROM OPENJSON(@rows) WITH (${openJsonSchema(cols)})) AS s ON ${on} ` +
    `WHEN MATCHED THEN UPDATE SET ${set} ` +
    `WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals});`
  );
}

/** Insert-only MERGE (Supabase upsert with ignoreDuplicates:true): never updates
 *  an existing row, so first_seen_date and friends are preserved. */
function insertOnlyMergeSql(table: string, cols: Col[], keyCols: string[]): string {
  const on = keyCols.map((k) => `t.${k} = s.${k}`).join(" AND ");
  const insCols = cols.map(([n]) => n).join(", ");
  const insVals = cols.map(([n]) => `s.${n}`).join(", ");
  return (
    `MERGE ${table} WITH (HOLDLOCK) AS t ` +
    `USING (SELECT * FROM OPENJSON(@rows) WITH (${openJsonSchema(cols)})) AS s ON ${on} ` +
    `WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals});`
  );
}

async function runJsonWrite(sqlText: string, rows: readonly unknown[]): Promise<number> {
  if (rows.length === 0) return 0;
  const pool = await getPool();
  return withDeadlockRetry(async () => {
    const res = await pool.request().input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(sqlText);
    return res.rowsAffected.reduce((a, b) => a + b, 0);
  });
}

// --- auctions: open + sold upserts (mirror parseListing / parseSoldListing) ---
const AUCTION_OPEN_COLS: Col[] = [
  ["platform", "NVARCHAR(2)"], ["asset_id", "NVARCHAR(128)"], ["seller_account_id", "NVARCHAR(128)"],
  ["seller_company", "NVARCHAR(512)"], ["category", "NVARCHAR(256)"], ["currency_code", "NVARCHAR(8)"],
  ["current_bid_usd", "REAL"], ["sale_amount_native", "DECIMAL(18,2)"], ["fx_rate_used", "REAL"],
  ["fx_source", "NVARCHAR(64)"], ["bid_count", "INT"], ["close_time_utc", "DATETIME2(0)"],
  ["status", "NVARCHAR(16)"], ["last_seen_at", "DATETIME2(3)"], ["row_business_id", "NVARCHAR(8)"],
  ["title", "NVARCHAR(MAX)"], ["country", "NVARCHAR(128)"], ["state", "NVARCHAR(128)"], ["city", "NVARCHAR(256)"],
  ["make", "NVARCHAR(256)"], ["model", "NVARCHAR(256)"], ["model_year", "NVARCHAR(16)"], ["lot_number", "NVARCHAR(64)"],
  ["keywords", "NVARCHAR(MAX)"], ["url", "NVARCHAR(MAX)"], ["event_id", "NVARCHAR(64)"], ["auction_type_id", "NVARCHAR(64)"],
  ["reserve_status", "NVARCHAR(32)"], ["is_new_asset", "BIT"], ["watch_count", "INT"],
];
// Sold rows additionally carry final_price_usd + closed_at (status = 'closed_sold').
const AUCTION_SOLD_COLS: Col[] = [...AUCTION_OPEN_COLS, ["final_price_usd", "REAL"], ["closed_at", "DATETIME2(0)"]];

const AUCTION_KEY = ["platform", "asset_id"];
const aucKey = (r: unknown) => `${(r as { platform: string }).platform}:${(r as { asset_id: string }).asset_id}`;

export async function azUpsertAuctionsOpen(rows: readonly object[]): Promise<number> {
  return runJsonWrite(upsertMergeSql("lqdt.auctions", AUCTION_OPEN_COLS, AUCTION_KEY), dedupBy(rows, aucKey));
}
export async function azUpsertAuctionsSold(rows: readonly object[]): Promise<number> {
  return runJsonWrite(upsertMergeSql("lqdt.auctions", AUCTION_SOLD_COLS, AUCTION_KEY), dedupBy(rows, aucKey));
}

/** Set-based closure sweep (replaces the read-ids-then-UPDATE-.in() Supabase
 *  path — no race window, no 500-row chunking). nosale (no bids) → closed_nosale
 *  with final 0; had bids → unknown (kept out of realized GMV until a sold feed
 *  confirms). */
export async function azSweepClosures(nowIso: string): Promise<{ sold: number; nosale: number; unknown: number }> {
  const pool = await getPool();
  const nosaleRes = await pool
    .request()
    .input("now", sql.DateTime2, new Date(nowIso))
    .query(
      "UPDATE lqdt.auctions SET status = 'closed_nosale', final_price_usd = 0, closed_at = @now " +
        "WHERE status = 'open' AND close_time_utc < @now AND (bid_count IS NULL OR bid_count = 0)",
    );
  const unknownRes = await pool
    .request()
    .input("now", sql.DateTime2, new Date(nowIso))
    .query(
      "UPDATE lqdt.auctions SET status = 'unknown', closed_at = @now " +
        "WHERE status = 'open' AND close_time_utc < @now AND bid_count > 0",
    );
  return { sold: 0, nosale: nosaleRes.rowsAffected[0] ?? 0, unknown: unknownRes.rowsAffected[0] ?? 0 };
}

// --- auctions: forecast live-quarter reads (no PostgREST 1000-row cap → no paging) ---
export async function azFetchAuctionsClosed(platform: string, startIso: string, endIso: string): Promise<Record<string, unknown>[]> {
  const pool = await getPool();
  const res = await pool
    .request()
    .input("p", sql.NVarChar(2), platform)
    .input("start", sql.DateTime2, new Date(startIso))
    .input("end", sql.DateTime2, new Date(endIso))
    .query(
      "SELECT asset_id, status, final_price_usd, current_bid_usd, close_time_utc, category, bid_count " +
        "FROM lqdt.auctions WHERE platform = @p AND close_time_utc >= @start AND close_time_utc < @end " +
        "AND status IN ('closed_sold','closed_nosale') ORDER BY close_time_utc DESC",
    );
  return res.recordset.map((r) => ({
    asset_id: r.asset_id,
    status: r.status,
    final_price_usd: num(r.final_price_usd),
    current_bid_usd: num(r.current_bid_usd),
    close_time_utc: iso(r.close_time_utc),
    category: r.category,
    bid_count: num(r.bid_count),
  }));
}

export async function azFetchAuctionsOpen(platform: string, nowIso: string, endIso: string): Promise<Record<string, unknown>[]> {
  const pool = await getPool();
  const res = await pool
    .request()
    .input("p", sql.NVarChar(2), platform)
    .input("now", sql.DateTime2, new Date(nowIso))
    .input("end", sql.DateTime2, new Date(endIso))
    .query(
      "SELECT asset_id, current_bid_usd, close_time_utc, category, bid_count " +
        "FROM lqdt.auctions WHERE platform = @p AND status = 'open' AND close_time_utc >= @now AND close_time_utc < @end " +
        "ORDER BY close_time_utc DESC",
    );
  return res.recordset.map((r) => ({
    asset_id: r.asset_id,
    current_bid_usd: num(r.current_bid_usd),
    close_time_utc: iso(r.close_time_utc),
    category: r.category,
    bid_count: num(r.bid_count),
  }));
}

/** For collectDebug: all rows' (platform, status, close_time_utc-as-ISO) + a sample row. */
export async function azFetchAuctionsDebug(): Promise<{ rows: { platform: string; status: string; close_time_utc: string | null }[]; sample: Record<string, unknown> | null }> {
  const pool = await getPool();
  const [all, sample] = await Promise.all([
    pool.request().query("SELECT platform, status, close_time_utc FROM lqdt.auctions"),
    pool.request().query("SELECT TOP (1) * FROM lqdt.auctions"),
  ]);
  return {
    rows: all.recordset.map((r) => ({ platform: String(r.platform), status: String(r.status), close_time_utc: iso(r.close_time_utc) })),
    sample: sample.recordset[0] ?? null,
  };
}

// --- marketplace_sellers upsert ---
const SELLER_COLS: Col[] = [
  ["date", "NVARCHAR(10)"], ["platform", "NVARCHAR(2)"], ["account_id", "NVARCHAR(128)"],
  ["company_name", "NVARCHAR(512)"], ["country", "NVARCHAR(128)"], ["state", "NVARCHAR(128)"],
  ["listing_count", "INT"], ["total_current_bid", "REAL"], ["total_bids", "INT"],
  ["top_bid_asset_id", "NVARCHAR(128)"], ["sub_business_id", "NVARCHAR(128)"],
];
export async function azUpsertMarketplaceSellers(rows: readonly object[]): Promise<number> {
  const key = (r: unknown) => { const o = r as { date: string; platform: string; account_id: string }; return `${o.date}:${o.platform}:${o.account_id}`; };
  return runJsonWrite(upsertMergeSql("lqdt.marketplace_sellers", SELLER_COLS, ["date", "platform", "account_id"]), dedupBy(rows, key));
}

// --- federal_contracts (insert-only) ---
const FEDERAL_COLS: Col[] = [
  ["award_id", "NVARCHAR(256)"], ["recipient_name", "NVARCHAR(512)"], ["award_amount", "REAL"],
  ["total_obligation", "REAL"], ["awarding_agency", "NVARCHAR(512)"], ["funding_agency", "NVARCHAR(512)"],
  ["award_type", "NVARCHAR(128)"], ["start_date", "NVARCHAR(10)"], ["end_date", "NVARCHAR(10)"],
  ["description", "NVARCHAR(MAX)"], ["place_of_performance_state", "NVARCHAR(128)"], ["naics_code", "NVARCHAR(32)"],
  ["first_seen_date", "NVARCHAR(10)"],
];
export async function azInsertFederalContracts(rows: readonly object[]): Promise<number> {
  return runJsonWrite(insertOnlyMergeSql("lqdt.federal_contracts", FEDERAL_COLS, ["award_id"]), dedupBy(rows, (r) => String((r as { award_id: unknown }).award_id)));
}

// --- sam_opportunities (insert-only) ---
const SAM_COLS: Col[] = [
  ["notice_id", "NVARCHAR(256)"], ["title", "NVARCHAR(MAX)"], ["solicitation_number", "NVARCHAR(256)"],
  ["organization", "NVARCHAR(512)"], ["posted_date", "NVARCHAR(10)"], ["response_deadline", "NVARCHAR(32)"],
  ["notice_type", "NVARCHAR(128)"], ["base_type", "NVARCHAR(128)"], ["naics_code", "NVARCHAR(32)"],
  ["classification_code", "NVARCHAR(32)"], ["description_url", "NVARCHAR(MAX)"], ["ui_link", "NVARCHAR(MAX)"],
  ["awardee_name", "NVARCHAR(512)"], ["awardee_uei", "NVARCHAR(64)"], ["award_amount", "DECIMAL(18,2)"],
  ["award_date", "NVARCHAR(10)"], ["set_aside", "NVARCHAR(256)"], ["pop_state", "NVARCHAR(128)"],
  ["pop_city", "NVARCHAR(256)"], ["first_seen_date", "NVARCHAR(10)"],
];
export async function azInsertSamOpportunities(rows: readonly object[]): Promise<number> {
  return runJsonWrite(insertOnlyMergeSql("lqdt.sam_opportunities", SAM_COLS, ["notice_id"]), dedupBy(rows, (r) => String((r as { notice_id: unknown }).notice_id)));
}

// --- contract_snapshots upsert (single row; top_agencies is JSON) ---
export async function azUpsertContractSnapshot(row: {
  date: string;
  total_active_contracts: number | null;
  total_obligated_amount: number | null;
  new_contracts_last_30d: number | null;
  new_obligation_last_30d: number | null;
  top_agencies: unknown;
}): Promise<void> {
  const pool = await getPool();
  await withDeadlockRetry(() =>
    pool
      .request()
      .input("date", sql.NVarChar(10), row.date)
      .input("tac", sql.Int, row.total_active_contracts)
      .input("toa", sql.Real, row.total_obligated_amount)
      .input("nc30", sql.Int, row.new_contracts_last_30d)
      .input("no30", sql.Real, row.new_obligation_last_30d)
      .input("top", sql.NVarChar(sql.MAX), row.top_agencies == null ? null : JSON.stringify(row.top_agencies))
      .query(
        "MERGE lqdt.contract_snapshots WITH (HOLDLOCK) AS t USING (SELECT @date AS date) AS s ON t.date = s.date " +
          "WHEN MATCHED THEN UPDATE SET total_active_contracts=@tac, total_obligated_amount=@toa, " +
          "new_contracts_last_30d=@nc30, new_obligation_last_30d=@no30, top_agencies=@top " +
          "WHEN NOT MATCHED THEN INSERT (date, total_active_contracts, total_obligated_amount, new_contracts_last_30d, new_obligation_last_30d, top_agencies) " +
          "VALUES (@date, @tac, @toa, @nc30, @no30, @top);",
      ),
  );
}

// --- state_contracts cost-aware upsert (OPENJSON + IS-DISTINCT-FROM guard;
//     preserves first_seen_date). Returns the affected row count. ---
const STATE_MERGE_SQL =
  "MERGE lqdt.state_contracts WITH (HOLDLOCK) AS t USING (SELECT * FROM OPENJSON(@rows) WITH (" +
  "state_code NVARCHAR(8), source_portal NVARCHAR(256), source_dataset_id NVARCHAR(256), contract_id NVARCHAR(256), " +
  "vendor_name NVARCHAR(512), vendor_normalized NVARCHAR(512), customer_agency NVARCHAR(512), contract_title NVARCHAR(MAX), " +
  "amount DECIMAL(18,2), year NVARCHAR(8), quarter NVARCHAR(8), period_start DATE, period_end DATE, " +
  "record_type NVARCHAR(32), source_query NVARCHAR(MAX), first_seen_date NVARCHAR(10), last_seen_date NVARCHAR(10))) AS s " +
  "ON t.state_code=s.state_code AND t.source_dataset_id=s.source_dataset_id AND t.contract_id=s.contract_id " +
  "AND t.vendor_normalized=s.vendor_normalized AND t.year=s.year AND t.quarter=s.quarter " +
  "AND t.customer_agency=s.customer_agency AND t.record_type=COALESCE(s.record_type,'payment') " +
  "WHEN MATCHED AND EXISTS (SELECT t.source_portal,t.vendor_name,t.contract_title,t.amount,t.period_start,t.period_end,t.source_query " +
  "EXCEPT SELECT s.source_portal,s.vendor_name,s.contract_title,s.amount,s.period_start,s.period_end,s.source_query) " +
  "THEN UPDATE SET source_portal=s.source_portal, vendor_name=s.vendor_name, contract_title=s.contract_title, amount=s.amount, " +
  "period_start=s.period_start, period_end=s.period_end, source_query=s.source_query, last_seen_date=s.last_seen_date " +
  "WHEN NOT MATCHED THEN INSERT (state_code, source_portal, source_dataset_id, contract_id, vendor_name, vendor_normalized, " +
  "customer_agency, contract_title, amount, year, quarter, period_start, period_end, record_type, source_query, first_seen_date, last_seen_date) " +
  "VALUES (s.state_code, s.source_portal, s.source_dataset_id, s.contract_id, s.vendor_name, s.vendor_normalized, s.customer_agency, " +
  "s.contract_title, s.amount, s.year, s.quarter, s.period_start, s.period_end, COALESCE(s.record_type,'payment'), s.source_query, " +
  "s.first_seen_date, s.last_seen_date);";

export async function azUpsertStateContracts(rows: readonly object[]): Promise<number> {
  const key = (r: unknown) => {
    const o = r as Record<string, unknown>;
    return [o.state_code, o.source_dataset_id, o.contract_id, o.vendor_normalized, o.year, o.quarter, o.customer_agency, o.record_type ?? "payment"].join("");
  };
  return runJsonWrite(STATE_MERGE_SQL, dedupBy(rows, key));
}

// --- fx_rates upsert ---
const FX_COLS: Col[] = [
  ["date", "NVARCHAR(10)"], ["currency", "NVARCHAR(8)"], ["usd_per_unit", "REAL"],
  ["source", "NVARCHAR(64)"], ["fetched_at", "DATETIME2(3)"],
];
export async function azUpsertFxRates(rows: readonly object[]): Promise<number> {
  const key = (r: unknown) => { const o = r as { date: string; currency: string }; return `${o.date}:${o.currency}`; };
  return runJsonWrite(upsertMergeSql("lqdt.fx_rates", FX_COLS, ["date", "currency"]), dedupBy(rows, key));
}

// --- cron_runs insert (best-effort; detail is JSON) ---
export async function azInsertCronRuns(rows: readonly object[]): Promise<number> {
  if (rows.length === 0) return 0;
  const pool = await getPool();
  const res = await pool
    .request()
    .input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
    .query(
      "INSERT INTO lqdt.cron_runs (run_id, source, status, rows_ingested, detail, error, started_at, ended_at, duration_ms) " +
        "SELECT run_id, source, status, rows_ingested, detail, error, started_at, ended_at, duration_ms FROM OPENJSON(@rows) WITH (" +
        "run_id UNIQUEIDENTIFIER, source NVARCHAR(64), status NVARCHAR(16), rows_ingested INT, detail NVARCHAR(MAX) AS JSON, " +
        "error NVARCHAR(MAX), started_at DATETIME2(3), ended_at DATETIME2(3), duration_ms INT)",
    );
  return res.rowsAffected.reduce((a, b) => a + b, 0);
}

// --- forecast_snapshots upsert (payload is JSON) ---
export async function azUpsertForecastSnapshot(quarter: string, payload: unknown): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("quarter", sql.NVarChar(16), quarter)
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .query(
      "MERGE lqdt.forecast_snapshots WITH (HOLDLOCK) AS t USING (SELECT @quarter AS quarter) AS s ON t.quarter = s.quarter " +
        "WHEN MATCHED THEN UPDATE SET payload=@payload, generated_at=SYSUTCDATETIME() " +
        "WHEN NOT MATCHED THEN INSERT (quarter, payload) VALUES (@quarter, @payload);",
    );
}
