// Azure SQL (cl-sql-db) data layer for the durable per-lot sold store.
//
// SERVER-ONLY. Connects as the least-privilege `lqdt_app` user (AZURE_SQL_*).
// The store mirrors the export's per-lot shape (deduped, true-marketplace incl.
// GI), so export / drill-down / forecast can read from here instead of the
// lossy, cross-listing-double-counted Supabase `auctions` table.
//
// Writes go bulk-load → MERGE (idempotent on asset_id+auction_id, scoped by a
// per-call batch_id so a backfill and the daily cron never collide). Re-running
// a capture updates in place; it never duplicates.
import sql from "mssql";
import { randomUUID } from "node:crypto";
import type { SoldExportRow } from "./sold-export";

const BULK_CHUNK = Number(process.env.AZURE_SQL_BULK_CHUNK) || 20000;

export function isAzureSqlConfigured(): boolean {
  return Boolean(
    process.env.AZURE_SQL_SERVER &&
      process.env.AZURE_SQL_DATABASE &&
      process.env.AZURE_SQL_USER &&
      process.env.AZURE_SQL_PASSWORD,
  );
}

function sqlConfig(): sql.config {
  const server = process.env.AZURE_SQL_SERVER;
  const database = process.env.AZURE_SQL_DATABASE;
  const user = process.env.AZURE_SQL_USER;
  const password = process.env.AZURE_SQL_PASSWORD;
  if (!server || !database || !user || !password) {
    throw new Error("Azure SQL is not configured (AZURE_SQL_SERVER/DATABASE/USER/PASSWORD).");
  }
  return {
    server,
    database,
    user,
    password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      // Serverless cl-sql-db auto-pauses after 60 min idle; the first query after
      // a pause has to wake it (~30-60s), so be patient on connect.
      connectTimeout: 90_000,
      requestTimeout: 120_000,
      useUTC: true,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
  };
}

let poolPromise: Promise<sql.ConnectionPool> | null = null;

/** Shared connection pool (lazy, singleton). Safe to call per request. */
export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(sqlConfig())
      .connect()
      .catch((e) => {
        poolPromise = null; // let the next call retry a fresh connection
        throw e;
      });
  }
  return poolPromise;
}

/** For one-off scripts (backfill) so the process can exit. */
export async function closePool(): Promise<void> {
  if (poolPromise) {
    const pool = await poolPromise.catch(() => null);
    poolPromise = null;
    if (pool) await pool.close();
  }
}

function clip(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// The store's identity = the export's dedup key exactly: site:account:asset:auction.
// asset_id/auction_id alone are NOT unique (reused across seller accounts), so all
// four parts are required or distinct lots get merged.
function soldRowKey(r: SoldExportRow): string {
  return `${r.site ?? ""}:${r.account_id ?? ""}:${r.asset_id ?? ""}:${r.auction_id ?? ""}`;
}

// Maestro occasionally returns a malformed or out-of-range close timestamp. Null
// out anything unparseable/out-of-range, and rebuild the rest at whole-second UTC
// so a fractional value can't trip the DATETIME2(0) bulk loader. (writeChunk also
// isolates/skips any row that still won't load.)
function toSqlDateTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

const MERGE_SQL = `
MERGE lqdt.sold_lots WITH (HOLDLOCK) AS T
USING (SELECT * FROM lqdt.sold_lots_staging WHERE batch_id = @bid) AS S
  ON T.row_key = S.row_key
WHEN MATCHED AND EXISTS (
  SELECT S.asset_id, S.auction_id, S.account_id, S.site, S.platform, S.seller, S.seller_type, S.gov_level,
         S.title, S.category, S.country, S.state, S.market, S.currency_code, S.sale_amount_native,
         S.sale_amount_usd, S.bid_count, S.url, S.close_time_utc, S.close_date_et
  EXCEPT
  SELECT T.asset_id, T.auction_id, T.account_id, T.site, T.platform, T.seller, T.seller_type, T.gov_level,
         T.title, T.category, T.country, T.state, T.market, T.currency_code, T.sale_amount_native,
         T.sale_amount_usd, T.bid_count, T.url, T.close_time_utc, T.close_date_et
) THEN UPDATE SET
  T.asset_id = S.asset_id, T.auction_id = S.auction_id, T.account_id = S.account_id, T.site = S.site,
  T.platform = S.platform, T.seller = S.seller, T.seller_type = S.seller_type, T.gov_level = S.gov_level,
  T.title = S.title, T.category = S.category, T.country = S.country, T.state = S.state, T.market = S.market,
  T.currency_code = S.currency_code, T.sale_amount_native = S.sale_amount_native,
  T.sale_amount_usd = S.sale_amount_usd, T.bid_count = S.bid_count, T.url = S.url,
  T.close_time_utc = S.close_time_utc, T.close_date_et = S.close_date_et, T.ingested_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (row_key, asset_id, auction_id, account_id, site, platform, seller, seller_type, gov_level, title, category,
   country, state, market, currency_code, sale_amount_native, sale_amount_usd, bid_count, url,
   close_time_utc, close_date_et)
  VALUES
  (S.row_key, S.asset_id, S.auction_id, S.account_id, S.site, S.platform, S.seller, S.seller_type, S.gov_level, S.title, S.category,
   S.country, S.state, S.market, S.currency_code, S.sale_amount_native, S.sale_amount_usd, S.bid_count, S.url,
   S.close_time_utc, S.close_date_et);`;

function newStagingTable(): sql.Table {
  const t = new sql.Table("lqdt.sold_lots_staging");
  t.create = false;
  t.columns.add("batch_id", sql.UniqueIdentifier, { nullable: false });
  t.columns.add("row_key", sql.NVarChar(220), { nullable: false });
  t.columns.add("asset_id", sql.NVarChar(64), { nullable: false });
  t.columns.add("auction_id", sql.NVarChar(64), { nullable: false });
  t.columns.add("account_id", sql.NVarChar(64), { nullable: true });
  t.columns.add("site", sql.NVarChar(8), { nullable: false });
  t.columns.add("platform", sql.NVarChar(8), { nullable: true });
  t.columns.add("seller", sql.NVarChar(256), { nullable: true });
  t.columns.add("seller_type", sql.NVarChar(16), { nullable: true });
  t.columns.add("gov_level", sql.NVarChar(16), { nullable: true });
  t.columns.add("title", sql.NVarChar(512), { nullable: true });
  t.columns.add("category", sql.NVarChar(160), { nullable: true });
  t.columns.add("country", sql.NVarChar(96), { nullable: true });
  t.columns.add("state", sql.NVarChar(96), { nullable: true });
  t.columns.add("market", sql.NVarChar(16), { nullable: true });
  t.columns.add("currency_code", sql.NVarChar(8), { nullable: true });
  t.columns.add("sale_amount_native", sql.Decimal(19, 4), { nullable: true });
  t.columns.add("sale_amount_usd", sql.Decimal(19, 4), { nullable: true });
  t.columns.add("bid_count", sql.Int, { nullable: true });
  t.columns.add("url", sql.NVarChar(1024), { nullable: true });
  t.columns.add("close_time_utc", sql.DateTime2(0), { nullable: true });
  t.columns.add("close_date_et", sql.Date, { nullable: false });
  return t;
}

function fillStagingTable(batchId: string, rows: SoldExportRow[]): sql.Table {
  const table = newStagingTable();
  for (const r of rows) {
    table.rows.add(
      batchId,
      clip(soldRowKey(r), 220),
      clip(r.asset_id, 64),
      clip(r.auction_id, 64),
      clip(r.account_id, 64),
      clip(r.site, 8),
      clip(r.platform, 8),
      clip(r.seller, 256),
      clip(r.seller_type, 16),
      clip(r.gov_level, 16),
      clip(r.title, 512),
      clip(r.category, 160),
      clip(r.country, 96),
      clip(r.state, 96),
      clip(r.market, 16),
      clip(r.currency_code, 8),
      r.sale_amount_native ?? null,
      r.sale_amount_usd ?? null,
      Number.isFinite(r.bid_count) ? r.bid_count : null,
      clip(r.url, 1024),
      toSqlDateTime(r.close_time_utc),
      // DATE column: parse the ET day key at UTC midnight (useUTC keeps the date part).
      new Date(`${r.close_date_et}T00:00:00Z`),
    );
  }
  return table;
}

function sqlErrorNumber(e: unknown): number | undefined {
  const err = e as { number?: number; originalError?: { info?: { number?: number } } } | null;
  return err?.number ?? err?.originalError?.info?.number;
}

async function mergeBatch(pool: sql.ConnectionPool, batchId: string): Promise<void> {
  // Concurrent MERGEs (backfill + cron) can deadlock; retry the victim (error 1205).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pool.request().input("bid", sql.UniqueIdentifier, batchId).query(MERGE_SQL);
      break;
    } catch (e) {
      if (sqlErrorNumber(e) === 1205 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  try {
    await pool
      .request()
      .input("bid", sql.UniqueIdentifier, batchId)
      .query(
        "MERGE lqdt.sold_coverage AS T " +
          "USING (SELECT DISTINCT close_date_et FROM lqdt.sold_lots_staging WHERE batch_id = @bid) AS S " +
          "ON T.close_date_et = S.close_date_et " +
          "WHEN MATCHED THEN UPDATE SET refreshed_at = SYSUTCDATETIME() " +
          "WHEN NOT MATCHED THEN INSERT (close_date_et) VALUES (S.close_date_et);",
      );
  } catch (error) {
    // Allow a rolling app deploy before migration 002 is applied.
    if (sqlErrorNumber(error) !== 208) throw error;
  }
  // Clear this batch's staging rows. Best-effort; a rare failed DELETE leaves rows
  // scoped to a dead batch_id (never re-selected) — acceptable vs. failing the write.
  await pool
    .request()
    .input("bid", sql.UniqueIdentifier, batchId)
    .query("DELETE FROM lqdt.sold_lots_staging WHERE batch_id = @bid")
    .catch(() => {});
}

// Returns the number of rows it could NOT persist (skipped as individually
// unloadable). A systemic bulk failure (dead connection, etc.) recursively splits
// to singletons; the caller treats a high skip count as a hard failure so it is
// never reported as silent success.
async function writeChunk(pool: sql.ConnectionPool, rows: SoldExportRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const batchId = randomUUID();
  try {
    await pool.request().bulk(fillStagingTable(batchId, rows));
  } catch (e) {
    // A single row the bulk loader rejects (e.g. a timestamp SQL won't accept)
    // aborts the whole batch. Split to isolate it, then skip just that row rather
    // than lose the chunk. A failed bulk commits nothing, so there's no cleanup.
    if (rows.length === 1) {
      console.error(
        "sold_lots: skipping unloadable row",
        soldRowKey(rows[0]),
        "close_time_utc=",
        JSON.stringify(rows[0].close_time_utc),
        e instanceof Error ? e.message : String(e),
      );
      return 1;
    }
    const mid = Math.floor(rows.length / 2);
    return (await writeChunk(pool, rows.slice(0, mid))) + (await writeChunk(pool, rows.slice(mid)));
  }
  await mergeBatch(pool, batchId);
  return 0;
}

/**
 * Idempotently upsert sold lots into lqdt.sold_lots. De-dups the input by row_key,
 * then bulk-loads → MERGEs in chunks. Returns the count actually persisted and the
 * count skipped as individually unloadable. Throws if the skip rate is high enough
 * to indicate a systemic failure (so a dead connection is never reported as a
 * successful capture of zero rows).
 */
export async function writeSoldLots(rows: SoldExportRow[]): Promise<{ written: number; skipped: number }> {
  if (!rows.length) return { written: 0, skipped: 0 };
  const seen = new Set<string>();
  const unique: SoldExportRow[] = [];
  for (const r of rows) {
    // Mirror fetchSoldRange, which keeps every row with a valid ET close date
    // (it does not require asset/auction ids); close_date_et is the one NOT NULL key.
    if (!r.close_date_et) continue;
    const k = soldRowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }
  const pool = await getPool();
  let skipped = 0;
  for (let i = 0; i < unique.length; i += BULK_CHUNK) {
    skipped += await writeChunk(pool, unique.slice(i, i + BULK_CHUNK));
  }
  const tolerance = Math.max(50, Math.floor(unique.length * 0.02));
  if (skipped > tolerance) {
    throw new Error(`sold_lots: ${skipped}/${unique.length} rows failed to load — aborting as systemic failure`);
  }
  return { written: unique.length - skipped, skipped };
}

/** Latest ET close-date present in the store (YYYY-MM-DD), or null if empty. */
export async function latestSoldDate(): Promise<string | null> {
  const pool = await getPool();
  const r = await pool
    .request()
    .query("SELECT CONVERT(char(10), MAX(close_date_et), 23) AS d FROM lqdt.sold_lots");
  return r.recordset[0]?.d ?? null;
}

/** Coverage stats for a date range (inclusive), for verification/monitoring. */
export async function soldCoverage(fromEt: string, toEt: string): Promise<{ lots: number; gmv: number; days: number }> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("from", sql.Date, new Date(`${fromEt}T00:00:00Z`))
    .input("to", sql.Date, new Date(`${toEt}T00:00:00Z`))
    .query(
      "SELECT COUNT(*) AS lots, COALESCE(SUM(sale_amount_usd),0) AS gmv, COUNT(DISTINCT close_date_et) AS days " +
        "FROM lqdt.sold_lots WHERE close_date_et BETWEEN @from AND @to",
    );
  const row = r.recordset[0] ?? {};
  return { lots: Number(row.lots ?? 0), gmv: Number(row.gmv ?? 0), days: Number(row.days ?? 0) };
}

/**
 * True only if the store has data for EVERY ET day in [from,to]. The marketplace
 * sells thousands of lots daily, so a day with zero rows means "not captured", not
 * "no sales" — this distinguishes a fully-covered range (safe to serve from the
 * store) from one with a leading/interior/trailing gap (must fall back to Maestro,
 * which still holds it). Prevents serving gap days as a complete $0 result.
 */
export async function storeCoversRange(fromEt: string, toEt: string): Promise<boolean> {
  const start = Date.parse(`${fromEt}T00:00:00Z`);
  const end = Date.parse(`${toEt}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return false;
  const calendarDays = Math.round((end - start) / 86_400_000) + 1;
  const pool = await getPool();
  try {
    const result = await pool
      .request()
      .input("from", sql.Date, new Date(`${fromEt}T00:00:00Z`))
      .input("to", sql.Date, new Date(`${toEt}T00:00:00Z`))
      .query("SELECT COUNT(*) AS days FROM lqdt.sold_coverage WHERE close_date_et BETWEEN @from AND @to");
    return Number(result.recordset[0]?.days ?? 0) >= calendarDays;
  } catch (error) {
    // Backward-compatible until 002_cost_optimizations.sql is deployed.
    if (sqlErrorNumber(error) !== 208) throw error;
    const { days } = await soldCoverage(fromEt, toEt);
    return days >= calendarDays;
  }
}

export type SoldDailyRow = {
  date: string; // YYYY-MM-DD (ET)
  site: string; // AD/GD/GI
  market: string; // domestic/international
  gmv: number; // realized USD
  lots: number; // sold lots with a positive price
};

/**
 * Per-day / per-site / per-market realized GMV from the store, for the forecast.
 * Complete + deduped + includes GI — unlike the Supabase `auctions` table. Only
 * lots with a positive USD price count toward gmv/lots.
 */
export async function getSoldDaily(fromEt: string, toEt: string): Promise<SoldDailyRow[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("from", sql.Date, new Date(`${fromEt}T00:00:00Z`))
    .input("to", sql.Date, new Date(`${toEt}T00:00:00Z`))
    .query(
      "SELECT CONVERT(char(10), close_date_et, 23) AS d, site, " +
        "COALESCE(market,'domestic') AS market, " +
        "COALESCE(SUM(sale_amount_usd),0) AS gmv, " +
        "SUM(CASE WHEN sale_amount_usd > 0 THEN 1 ELSE 0 END) AS lots " +
        "FROM lqdt.sold_lots WHERE close_date_et BETWEEN @from AND @to " +
        "GROUP BY close_date_et, site, COALESCE(market,'domestic')",
    );
  return r.recordset.map((x) => ({
    date: x.d,
    site: String(x.site ?? ""),
    market: String(x.market ?? "domestic"),
    gmv: Number(x.gmv ?? 0),
    lots: Number(x.lots ?? 0),
  }));
}

export type CategoryDailyRow = { date: string; category: string; gmv: number };

/**
 * Per-day / per-category realized GMV from the store, for the revenue-by-category
 * chart. Complete + deduped (incl. GI) and fast: one indexed GROUP BY over the
 * range replaces /api/gmv-by-category's old full-range Maestro pull, which timed
 * out on wide windows. The caller buckets days into the requested period and keeps
 * the top-N categories. Only lots with a positive USD price count.
 */
export async function getCategoryDaily(fromEt: string, toEt: string): Promise<CategoryDailyRow[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("from", sql.Date, new Date(`${fromEt}T00:00:00Z`))
    .input("to", sql.Date, new Date(`${toEt}T00:00:00Z`))
    .query(
      "SELECT CONVERT(char(10), close_date_et, 23) AS d, " +
        "COALESCE(NULLIF(LTRIM(RTRIM(category)), ''), 'Uncategorized') AS category, " +
        "COALESCE(SUM(sale_amount_usd), 0) AS gmv " +
        "FROM lqdt.sold_lots WHERE close_date_et BETWEEN @from AND @to AND sale_amount_usd > 0 " +
        "GROUP BY close_date_et, COALESCE(NULLIF(LTRIM(RTRIM(category)), ''), 'Uncategorized')",
    );
  return r.recordset.map((x) => ({
    date: x.d,
    category: String(x.category ?? "Uncategorized"),
    gmv: Number(x.gmv ?? 0),
  }));
}

export type SoldGroupDailyRow = {
  date: string; // YYYY-MM-DD (ET)
  group: "gov" | "retail" | "intl";
  gmv: number; // realized USD
  lots: number; // sold lots with a positive price
  bids: number; // total bids across the group's lots
};

/**
 * Per-day realized GMV/lots/bids by honest scrape axes — NOT LQDT's segment names:
 *   intl   = site 'GI' (the international marketplace)
 *   gov    = government sellers on AD/GD (seller_type='government')
 *   retail = the remainder (retail sellers on AD/GD; NULL seller_type lands here,
 *            matching the reader default elsewhere in this module)
 * The QTD page compares each group against its closest reported segment
 * (GovDeals / RSCG+CAG / CAG). bid_count sums as bigint — int SUM overflows at
 * ~2.1B and a quarter already carries ~2.2M bids.
 */
export async function getSoldDailyByGroup(fromEt: string, toEt: string): Promise<SoldGroupDailyRow[]> {
  const grp =
    "CASE WHEN site = 'GI' THEN 'intl' WHEN seller_type = 'government' THEN 'gov' ELSE 'retail' END";
  const pool = await getPool();
  const r = await pool
    .request()
    .input("from", sql.Date, new Date(`${fromEt}T00:00:00Z`))
    .input("to", sql.Date, new Date(`${toEt}T00:00:00Z`))
    .query(
      `SELECT CONVERT(char(10), close_date_et, 23) AS d, ${grp} AS grp, ` +
        "COALESCE(SUM(sale_amount_usd),0) AS gmv, " +
        "SUM(CASE WHEN sale_amount_usd > 0 THEN 1 ELSE 0 END) AS lots, " +
        "COALESCE(SUM(CAST(bid_count AS bigint)),0) AS bids " +
        "FROM lqdt.sold_lots WHERE close_date_et BETWEEN @from AND @to " +
        `GROUP BY close_date_et, ${grp}`,
    );
  return r.recordset.map((x) => ({
    date: x.d,
    group: (x.grp === "gov" || x.grp === "intl" ? x.grp : "retail") as SoldGroupDailyRow["group"],
    gmv: Number(x.gmv ?? 0),
    lots: Number(x.lots ?? 0),
    bids: Number(x.bids ?? 0),
  }));
}

// --- analyst estimate overrides (guidance / Clearline) ----------------------
//
// Small keyed table holding per-quarter overrides entered from the QTD page.
// Lives in Azure SQL (not Supabase). One-time bootstrap: run
// azure-sql/003_model_estimates.sql as an admin — lqdt_app owns the lqdt schema
// but lacked database-level CREATE TABLE, so the in-code ensure() below only
// works after 003's GRANT (or once the table exists, where it no-ops). Until
// then saves fail with a clear error and reads degrade to the model-file values.

export type ModelEstimateOverrideRow = {
  quarter: string; // calendar "YYYYQn"
  guidance_low_usd: number | null;
  guidance_high_usd: number | null;
  clearline_estimate_usd: number | null;
  updated_by: string | null;
  updated_at: string | null; // ISO 8601
};

let estimatesTableEnsured = false;

/** Create lqdt.model_estimates on first use (idempotent, once per process). */
async function ensureModelEstimatesTable(pool: sql.ConnectionPool): Promise<void> {
  if (estimatesTableEnsured) return;
  await pool
    .request()
    .batch(
      "IF OBJECT_ID('lqdt.model_estimates', 'U') IS NULL " +
        "CREATE TABLE lqdt.model_estimates (" +
        "quarter char(6) NOT NULL PRIMARY KEY, " +
        "guidance_low_usd bigint NULL, " +
        "guidance_high_usd bigint NULL, " +
        "clearline_estimate_usd bigint NULL, " +
        "updated_by nvarchar(256) NULL, " +
        "updated_at datetime2(0) NOT NULL DEFAULT sysutcdatetime())",
    );
  estimatesTableEnsured = true;
}

export async function getModelEstimateOverrides(): Promise<ModelEstimateOverrideRow[]> {
  const pool = await getPool();
  await ensureModelEstimatesTable(pool);
  const r = await pool
    .request()
    .query(
      "SELECT quarter, guidance_low_usd, guidance_high_usd, clearline_estimate_usd, updated_by, " +
        "CONVERT(varchar(33), updated_at, 127) AS updated_at FROM lqdt.model_estimates",
    );
  return r.recordset.map((x) => ({
    quarter: String(x.quarter ?? "").trim(),
    guidance_low_usd: x.guidance_low_usd == null ? null : Number(x.guidance_low_usd),
    guidance_high_usd: x.guidance_high_usd == null ? null : Number(x.guidance_high_usd),
    clearline_estimate_usd: x.clearline_estimate_usd == null ? null : Number(x.clearline_estimate_usd),
    updated_by: x.updated_by == null ? null : String(x.updated_by),
    updated_at: x.updated_at == null ? null : String(x.updated_at),
  }));
}

export async function upsertModelEstimateOverride(row: {
  quarter: string;
  guidance_low_usd: number | null;
  guidance_high_usd: number | null;
  clearline_estimate_usd: number | null;
  updated_by: string;
}): Promise<void> {
  const pool = await getPool();
  await ensureModelEstimatesTable(pool);
  await pool
    .request()
    .input("quarter", sql.Char(6), row.quarter)
    .input("low", sql.BigInt, row.guidance_low_usd)
    .input("high", sql.BigInt, row.guidance_high_usd)
    .input("cl", sql.BigInt, row.clearline_estimate_usd)
    .input("by", sql.NVarChar(256), clip(row.updated_by, 256))
    .query(
      "MERGE lqdt.model_estimates AS t USING (SELECT @quarter AS quarter) AS s ON t.quarter = s.quarter " +
        "WHEN MATCHED THEN UPDATE SET guidance_low_usd = @low, guidance_high_usd = @high, " +
        "clearline_estimate_usd = @cl, updated_by = @by, updated_at = sysutcdatetime() " +
        "WHEN NOT MATCHED THEN INSERT (quarter, guidance_low_usd, guidance_high_usd, clearline_estimate_usd, updated_by) " +
        "VALUES (@quarter, @low, @high, @cl, @by);",
    );
}

export async function deleteModelEstimateOverride(quarter: string): Promise<void> {
  const pool = await getPool();
  await ensureModelEstimatesTable(pool);
  await pool.request().input("quarter", sql.Char(6), quarter).query("DELETE FROM lqdt.model_estimates WHERE quarter = @quarter");
}

/**
 * Read raw per-lot rows from the store as SoldExportRow[] (the shape the export /
 * drill-down already consume). Lets those readers move off the live Maestro feed
 * onto the durable store for any retained date — and reach data that has since
 * aged out of Maestro's ~12-month archive.
 */
export type SoldLotReadFilters = {
  site?: string;
  sellerType?: string;
  govLevel?: string;
  market?: string;
  category?: string;
  state?: string;
  country?: string;
  minUsd?: number;
  maxUsd?: number;
};

export async function readSoldLots(
  fromEt: string,
  toEt: string,
  filters: SoldLotReadFilters = {},
): Promise<SoldExportRow[]> {
  const pool = await getPool();
  const request = pool
    .request()
    .input("from", sql.Date, new Date(`${fromEt}T00:00:00Z`))
    .input("to", sql.Date, new Date(`${toEt}T00:00:00Z`));
  const where = ["close_date_et BETWEEN @from AND @to"];
  const exact = [
    ["site", "site", filters.site],
    ["sellerType", "seller_type", filters.sellerType],
    ["govLevel", "gov_level", filters.govLevel],
    ["market", "market", filters.market],
  ] as const;
  for (const [parameter, column, value] of exact) {
    if (!value) continue;
    request.input(parameter, sql.NVarChar, value);
    where.push(`${column} = @${parameter}`);
  }
  const contains = [
    ["category", "category", filters.category],
    ["state", "state", filters.state],
    ["country", "country", filters.country],
  ] as const;
  for (const [parameter, column, value] of contains) {
    if (!value) continue;
    request.input(parameter, sql.NVarChar, `%${value}%`);
    where.push(`${column} LIKE @${parameter}`);
  }
  if (filters.minUsd != null) {
    request.input("minUsd", sql.Decimal(19, 4), filters.minUsd);
    where.push("sale_amount_usd >= @minUsd");
  }
  if (filters.maxUsd != null) {
    request.input("maxUsd", sql.Decimal(19, 4), filters.maxUsd);
    where.push("sale_amount_usd <= @maxUsd");
  }
  const r = await request.query(
      "SELECT asset_id, auction_id, account_id, site, platform, seller, seller_type, gov_level, " +
        "title, category, country, state, market, currency_code, sale_amount_native, sale_amount_usd, " +
        "bid_count, url, close_time_utc, CONVERT(char(10), close_date_et, 23) AS close_date_et " +
        `FROM lqdt.sold_lots WHERE ${where.join(" AND ")}`,
    );
  return r.recordset.map((x): SoldExportRow => {
    const closeIso = x.close_time_utc instanceof Date ? x.close_time_utc.toISOString() : (x.close_time_utc ?? "");
    return {
      platform: String(x.platform ?? x.site ?? ""),
      asset_id: String(x.asset_id ?? ""),
      auction_id: String(x.auction_id ?? ""),
      account_id: String(x.account_id ?? ""),
      title: String(x.title ?? ""),
      seller: String(x.seller ?? ""),
      category: String(x.category ?? ""),
      country: String(x.country ?? ""),
      state: String(x.state ?? ""),
      close_time_utc: closeIso,
      // Leave display empty so the UI formats close_time_utc in ET (the store never
      // persisted Maestro's display string; passing the raw UTC ISO would show UTC).
      close_time_display: "",
      currency_code: String(x.currency_code ?? ""),
      sale_amount_native: x.sale_amount_native == null ? 0 : Number(x.sale_amount_native),
      sale_amount_usd: x.sale_amount_usd == null ? null : Number(x.sale_amount_usd),
      bid_count: x.bid_count == null ? 0 : Number(x.bid_count),
      url: x.url == null ? null : String(x.url),
      close_date_et: String(x.close_date_et ?? ""),
      site: String(x.site ?? ""),
      gov_level: (x.gov_level ?? "commercial") as SoldExportRow["gov_level"],
      seller_type: (x.seller_type ?? "retail") as SoldExportRow["seller_type"],
      market: (x.market ?? "domestic") as SoldExportRow["market"],
    };
  });
}
