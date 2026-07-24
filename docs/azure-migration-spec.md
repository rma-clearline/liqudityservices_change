# LQDT: Full Supabase → Azure SQL Migration Spec

**Status:** proposed — for review before any prod change.
**Author:** generated from a 6-dimension code inventory (tables, reads, writes, existing Azure conventions, infra/env, data-migration).

## Decisions locked (from review)
1. **Full spec first** — this document; nothing touches prod until it's approved.
2. **Preserve must-copy history** — paginated copy + parity for the reference tables; disposable tables start empty and refill.
3. **Optimize on S2 first** — keep `cl-sql-db` on Standard S2 (50 DTU); add indexes / lean queries, scale only if monitoring shows contention.

---

## 1. Goal & scope

Move **all** app data off Supabase (Postgres + PostgREST + RLS) onto **Azure SQL** (`cl-sql-db`, schema `lqdt`), consolidating with the durable `lqdt.sold_lots` store already there. Remove `@supabase/supabase-js`, the three `SUPABASE`/`NEXT_PUBLIC_SUPABASE_*` env vars, and all RLS reliance.

**Unchanged / out of scope:** Maestro is still the live feed + read fallback; Entra is still auth (Supabase Auth was never used); `lqdt.sold_lots` is already Azure; reported-GMV/model data is CSV-file based (`REPORTED_GMV_QUARTERLY_PATH` etc.), **not** a Supabase dependency — do not migrate it. No Supabase Realtime / Storage / Edge Functions are in use.

**Access shape today:** all data access is server-side. Reads go through the `supabase` client (`src/lib/supabase.ts`); every write goes through the service-role `supabaseAdmin`, driven almost entirely by `GET /api/cron` (plus `src/lib/fx.ts` and `src/lib/cron-log.ts`). Two tables — `forecast_snapshots` and `cron_runs` — are **already dead in prod** (PostgREST `PGRST205`), so their read/write paths silently no-op today.

---

## 2. Table disposition matrix

| Relation | Disposition | Why |
|---|---|---|
| `listings` | **Copy** | 2-yr chart history; ~1 row/day |
| `marketplace_sellers` | **Copy** | 548-day retention; feeds the deltas view + Gov Sellers widget |
| `federal_contracts` | **Copy** | insert-only history |
| `contract_snapshots` | **Copy** | daily rollup; jsonb `top_agencies` |
| `sam_opportunities` | **Copy** | insert-only history |
| `state_contracts` | **Copy** | largest reference set; cost-aware upsert + first-seen preservation |
| `fx_rates` | **Copy** | small; USD-reproducibility audit trail |
| `auctions` | **Create empty (re-derive)** | lossy duplicate of `sold_lots`; refills in one 4h cron. Copying re-imports the cross-listing double-count — an anti-goal |
| `forecast_snapshots` | **Create empty (re-derive)** | recomputable cache; cron regenerates. Currently dead → migrating **revives** the forecast fast-path |
| `cron_runs` | **Create empty** | audit log; history disposable. Currently dead → migrating **revives** logging + data-status + report deltas |
| `marketplace_metrics` (table) | **Drop** | zero code references (migrations 002/017 only) |
| `auction_daily_stats` (view) | **Drop** | unused — only a comment reference in `time.ts` |
| `marketplace_seller_deltas` (view) | **Port to Azure view** | queried in `dashboard-data.ts:109` |

⚠️ Reviving `forecast_snapshots` and `cron_runs` is a **behavior change, not a port** — they are dark today. Each needs a functional check after cutover, not just a schema check.

---

## 3. Type-mapping rules (Postgres → Azure SQL)

| Postgres | Azure SQL | Notes |
|---|---|---|
| `bigint generated always as identity` PK | `BIGINT IDENTITY(1,1) PRIMARY KEY` | |
| `text` (freeform) | `NVARCHAR(4000)` / `NVARCHAR(MAX)` for descriptions/URLs/JSON | |
| `text` holding an **ISO date/timestamp string** | **`NVARCHAR`** — keep as text | app orders these lexically (`listings.date/timestamp`, all contract `*_date`, `state.year/quarter`). Converting to `DATE` breaks ordering/equality |
| `timestamptz` | `DATETIMEOFFSET` | `default now()` → `DEFAULT SYSDATETIMEOFFSET()` |
| `real` | `REAL` | bids, `usd_per_unit`, `fx_rate_used` |
| `numeric` (money) | `DECIMAL(18,2)` | `sam/state.amount`, `auctions.sale_amount_native` |
| `boolean` | `BIT` | `auctions.is_new_asset` |
| `jsonb` | `NVARCHAR(MAX)` (`CHECK (ISJSON(col)=1)`) | **must** `JSON.parse`/`JSON.stringify` at the app boundary — mssql does not auto-parse |
| `uuid` | `UNIQUEIDENTIFIER` | `cron_runs.run_id` |
| `date` (real dates) | `DATE` | `state_contracts.period_start/period_end` only |
| `CHECK (… in (…))` | `CHECK` | `platform`, `status` carry over unchanged |
| `unique (…)` | `UNIQUE INDEX` / `CONSTRAINT … UNIQUE` | becomes the MERGE join key |
| RLS `public read` + anon/service split | — | **removed**; one app SQL login, server-only access, Entra remains the boundary |

**jsonb columns to guard explicitly:** `contract_snapshots.top_agencies`, `cron_runs.detail`, `forecast_snapshots.payload` (large per-quarter `RevenueForecast` blob), `state_contracts.raw_data` (now always NULL).

---

## 4. Target schema DDL (`lqdt` schema, idempotent, `lqdt_app`-owned)

New numbered files under `azure-sql/` (continuing after `004_model_estimates.sql`). All follow the existing conventions: `IF NOT EXISTS`, `lqdt` schema, indexes mirrored from the Supabase originals.

```sql
-- azure-sql/005_listings.sql
CREATE TABLE lqdt.listings (
  id           BIGINT IDENTITY(1,1) PRIMARY KEY,
  date         NVARCHAR(10) NOT NULL,
  timestamp    NVARCHAR(8),
  allsurplus   INT,
  govdeals     INT,
  created_at   DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT listings_date_unique UNIQUE (date)
);

-- azure-sql/006_marketplace_sellers.sql
CREATE TABLE lqdt.marketplace_sellers (
  id                BIGINT IDENTITY(1,1) PRIMARY KEY,
  date              NVARCHAR(10) NOT NULL,
  platform          NVARCHAR(2)  NOT NULL CHECK (platform IN ('AD','GD')),
  account_id        NVARCHAR(128) NOT NULL,
  company_name      NVARCHAR(512),
  country           NVARCHAR(128),
  state             NVARCHAR(128),
  listing_count     INT,
  total_current_bid REAL,
  total_bids        INT,
  top_bid_asset_id  NVARCHAR(128),
  sub_business_id   NVARCHAR(128),
  created_at        DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT marketplace_sellers_uniq UNIQUE (date, platform, account_id)
);
CREATE INDEX ix_ms_date_bid ON lqdt.marketplace_sellers (date, total_current_bid DESC);

-- azure-sql/007_federal_contracts.sql
CREATE TABLE lqdt.federal_contracts (
  id                          BIGINT IDENTITY(1,1) PRIMARY KEY,
  award_id                    NVARCHAR(256) NOT NULL,
  recipient_name              NVARCHAR(512),
  award_amount                REAL,
  total_obligation            REAL,
  awarding_agency             NVARCHAR(512),
  funding_agency              NVARCHAR(512),
  award_type                  NVARCHAR(128),
  start_date                  NVARCHAR(10),
  end_date                    NVARCHAR(10),
  description                 NVARCHAR(MAX),
  place_of_performance_state  NVARCHAR(128),
  naics_code                  NVARCHAR(32),
  first_seen_date             NVARCHAR(10) NOT NULL,
  created_at                  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT federal_contracts_award_id_unique UNIQUE (award_id)
);
CREATE INDEX ix_fc_start ON lqdt.federal_contracts (start_date DESC);

-- azure-sql/008_contract_snapshots.sql
CREATE TABLE lqdt.contract_snapshots (
  id                       BIGINT IDENTITY(1,1) PRIMARY KEY,
  date                     NVARCHAR(10) NOT NULL,
  total_active_contracts   INT,
  total_obligated_amount   REAL,
  new_contracts_last_30d   INT,
  new_obligation_last_30d  REAL,
  top_agencies             NVARCHAR(MAX) CHECK (top_agencies IS NULL OR ISJSON(top_agencies)=1),
  created_at               DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT contract_snapshots_date_unique UNIQUE (date)
);

-- azure-sql/009_sam_opportunities.sql
CREATE TABLE lqdt.sam_opportunities (
  id                   BIGINT IDENTITY(1,1) PRIMARY KEY,
  notice_id            NVARCHAR(256) NOT NULL,
  title                NVARCHAR(MAX),
  solicitation_number  NVARCHAR(256),
  organization         NVARCHAR(512),
  posted_date          NVARCHAR(10),
  response_deadline    NVARCHAR(32),
  notice_type          NVARCHAR(128),
  base_type            NVARCHAR(128),
  naics_code           NVARCHAR(32),
  classification_code  NVARCHAR(32),
  description_url      NVARCHAR(MAX),
  ui_link              NVARCHAR(MAX),
  awardee_name         NVARCHAR(512),
  awardee_uei          NVARCHAR(64),
  award_amount         DECIMAL(18,2),
  award_date           NVARCHAR(10),
  set_aside            NVARCHAR(256),
  pop_state            NVARCHAR(128),
  pop_city             NVARCHAR(256),
  first_seen_date      NVARCHAR(10) NOT NULL,
  created_at           DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT sam_notice_id_unique UNIQUE (notice_id)
);
CREATE INDEX ix_sam_posted ON lqdt.sam_opportunities (posted_date DESC);

-- azure-sql/010_state_contracts.sql
CREATE TABLE lqdt.state_contracts (
  id                BIGINT IDENTITY(1,1) PRIMARY KEY,
  state_code        NVARCHAR(8)  NOT NULL,
  source_portal     NVARCHAR(256),
  source_dataset_id NVARCHAR(256) NOT NULL,
  contract_id       NVARCHAR(256) NOT NULL,
  vendor_name       NVARCHAR(512),
  vendor_normalized NVARCHAR(512) NOT NULL,
  customer_agency   NVARCHAR(512) NOT NULL,
  contract_title    NVARCHAR(MAX),
  amount            DECIMAL(18,2),
  year              NVARCHAR(8)  NOT NULL,
  quarter           NVARCHAR(8)  NOT NULL,
  period_start      DATE,
  period_end        DATE,
  record_type       NVARCHAR(32) NOT NULL DEFAULT 'payment',
  raw_data          NVARCHAR(MAX),
  source_query      NVARCHAR(MAX),
  first_seen_date   NVARCHAR(10) NOT NULL,
  last_seen_date    NVARCHAR(10),
  created_at        DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT state_contracts_uniq UNIQUE
    (state_code, source_dataset_id, contract_id, vendor_normalized, year, quarter, customer_agency, record_type)
);

-- azure-sql/011_fx_rates.sql
CREATE TABLE lqdt.fx_rates (
  id           BIGINT IDENTITY(1,1) PRIMARY KEY,
  date         NVARCHAR(10) NOT NULL,
  currency     NVARCHAR(8)  NOT NULL,
  usd_per_unit REAL NOT NULL,
  source       NVARCHAR(64) NOT NULL,
  fetched_at   DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  created_at   DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT fx_rates_date_currency_unique UNIQUE (date, currency)
);
CREATE INDEX ix_fx_ccy_date ON lqdt.fx_rates (currency, date DESC);

-- azure-sql/012_auctions.sql   (create empty; re-derived by the cron)
CREATE TABLE lqdt.auctions (
  id                 BIGINT IDENTITY(1,1) PRIMARY KEY,
  platform           NVARCHAR(2) NOT NULL CHECK (platform IN ('AD','GD')),
  asset_id           NVARCHAR(128) NOT NULL,
  seller_account_id  NVARCHAR(128),
  seller_company     NVARCHAR(512),
  category           NVARCHAR(256),
  currency_code      NVARCHAR(8),
  current_bid_usd    REAL,
  bid_count          INT,
  close_time_utc     DATETIMEOFFSET,
  status             NVARCHAR(16) NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','closed_sold','closed_nosale','unknown')),
  final_price_usd    REAL,
  first_seen_at      DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  last_seen_at       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  closed_at          DATETIMEOFFSET,
  created_at         DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  -- enrichment (Supabase migration 013)
  title NVARCHAR(MAX), country NVARCHAR(128), state NVARCHAR(128), city NVARCHAR(256),
  make NVARCHAR(256), model NVARCHAR(256), model_year NVARCHAR(16), lot_number NVARCHAR(64),
  keywords NVARCHAR(MAX), url NVARCHAR(MAX), event_id NVARCHAR(64), auction_type_id NVARCHAR(64),
  row_business_id NVARCHAR(8), reserve_status NVARCHAR(32), is_new_asset BIT,
  sale_amount_native DECIMAL(18,2), fx_rate_used REAL, fx_source NVARCHAR(64), watch_count INT,
  CONSTRAINT auctions_platform_asset_unique UNIQUE (platform, asset_id)
);
CREATE INDEX ix_auc_open_close   ON lqdt.auctions (close_time_utc) WHERE status = 'open';
CREATE INDEX ix_auc_status_close ON lqdt.auctions (status, close_time_utc DESC);
CREATE INDEX ix_auc_seller       ON lqdt.auctions (seller_account_id, platform);

-- azure-sql/013_cron_runs.sql   (create empty)
CREATE TABLE lqdt.cron_runs (
  id            BIGINT IDENTITY(1,1) PRIMARY KEY,
  run_id        UNIQUEIDENTIFIER NOT NULL,
  source        NVARCHAR(64) NOT NULL,
  status        NVARCHAR(16) NOT NULL CHECK (status IN ('success','partial','failed','skipped')),
  rows_ingested INT,
  detail        NVARCHAR(MAX) CHECK (detail IS NULL OR ISJSON(detail)=1),
  error         NVARCHAR(MAX),
  started_at    DATETIMEOFFSET NOT NULL,
  ended_at      DATETIMEOFFSET,
  duration_ms   INT,
  created_at    DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
CREATE INDEX ix_cron_started        ON lqdt.cron_runs (started_at DESC);
CREATE INDEX ix_cron_source_started ON lqdt.cron_runs (source, started_at DESC);

-- azure-sql/014_forecast_snapshots.sql   (create empty; cron regenerates)
CREATE TABLE lqdt.forecast_snapshots (
  quarter      NVARCHAR(16) PRIMARY KEY,
  payload      NVARCHAR(MAX) NOT NULL CHECK (ISJSON(payload)=1),
  generated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
CREATE INDEX ix_fs_generated ON lqdt.forecast_snapshots (generated_at DESC);
```

---

## 5. Stored-proc & view ports (T-SQL)

### 5.1 `marketplace_seller_deltas` → `lqdt.marketplace_seller_deltas` (view)
Direct translation — `ROW_NUMBER()`, `FULL OUTER JOIN`, `COALESCE` all exist in T-SQL; drop `security_invoker` (no equivalent; access is server-only anyway).

```sql
CREATE OR ALTER VIEW lqdt.marketplace_seller_deltas AS
WITH ranked_dates AS (
  SELECT platform, date,
         ROW_NUMBER() OVER (PARTITION BY platform ORDER BY date DESC) AS rn
  FROM (SELECT DISTINCT platform, date FROM lqdt.marketplace_sellers) d
),
latest   AS (SELECT platform, date FROM ranked_dates WHERE rn = 1),
previous AS (SELECT platform, date FROM ranked_dates WHERE rn = 2),
cur AS (
  SELECT s.platform, s.account_id, s.company_name, s.country, s.state,
         s.listing_count, s.total_current_bid, s.total_bids, s.date
  FROM lqdt.marketplace_sellers s
  JOIN latest l ON s.platform = l.platform AND s.date = l.date
),
pr AS (
  SELECT s.platform, s.account_id,
         s.listing_count AS prev_listing_count,
         s.total_current_bid AS prev_total_current_bid,
         s.date AS prev_date
  FROM lqdt.marketplace_sellers s
  JOIN previous p ON s.platform = p.platform AND s.date = p.date
)
SELECT
  COALESCE(cur.platform, pr.platform)       AS platform,
  COALESCE(cur.account_id, pr.account_id)   AS account_id,
  cur.company_name, cur.country, cur.state,
  cur.date AS snapshot_date, pr.prev_date,
  cur.listing_count, pr.prev_listing_count,
  COALESCE(cur.listing_count,0) - COALESCE(pr.prev_listing_count,0)         AS listing_count_delta,
  cur.total_current_bid, pr.prev_total_current_bid,
  COALESCE(cur.total_current_bid,0) - COALESCE(pr.prev_total_current_bid,0) AS gmv_delta,
  CAST(CASE WHEN pr.account_id  IS NULL THEN 1 ELSE 0 END AS BIT) AS is_new,
  CAST(CASE WHEN cur.account_id IS NULL THEN 1 ELSE 0 END AS BIT) AS disappeared
FROM cur
FULL OUTER JOIN pr ON cur.platform = pr.platform AND cur.account_id = pr.account_id;
```

### 5.2 `latest_data_freshness()` → `lqdt.sp_latest_data_freshness`
Now that `cron_runs` + `state_contracts` are both in Azure, the composite freshness works natively. Return one row (the app reads the columns).

```sql
CREATE OR ALTER PROCEDURE lqdt.sp_latest_data_freshness AS
BEGIN
  SET NOCOUNT ON;
  SELECT
    (SELECT MAX(date) FROM lqdt.listings)                                   AS listings,
    (SELECT MAX(date) FROM lqdt.marketplace_sellers)                        AS marketplace_sellers,
    (SELECT CONVERT(NVARCHAR(35), MAX(last_seen_at)) FROM lqdt.auctions)    AS auctions,
    (SELECT MAX(first_seen_date) FROM lqdt.federal_contracts)               AS federal_contracts,
    (SELECT MAX(date) FROM lqdt.contract_snapshots)                         AS contract_snapshots,
    (SELECT MAX(first_seen_date) FROM lqdt.sam_opportunities)               AS sam_opportunities,
    COALESCE(
      (SELECT CONVERT(NVARCHAR(35), MAX(ended_at)) FROM lqdt.cron_runs
         WHERE source = 'state_contracts' AND status IN ('success','partial')),
      (SELECT MAX(COALESCE(last_seen_date, first_seen_date)) FROM lqdt.state_contracts)
    )                                                                       AS state_contracts;
END;
```
> The current `/api/data-status` already has a per-table `MAX()` fallback for when the RPC errors; keep that fallback but re-point it at Azure.

### 5.3 `run_cost_retention()` → `lqdt.sp_run_cost_retention`
Same three deletes; return counts as JSON. **Invoked from the daily cron run** (a new task), since there's no `pg_cron` equivalent — see §7.

```sql
CREATE OR ALTER PROCEDURE lqdt.sp_run_cost_retention AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @cron INT, @sellers INT, @auctions INT;
  DELETE FROM lqdt.cron_runs WHERE started_at < DATEADD(day, -90, SYSDATETIMEOFFSET());
  SET @cron = @@ROWCOUNT;
  DELETE FROM lqdt.marketplace_sellers
    WHERE date < CONVERT(NVARCHAR(10), DATEADD(day, -548, CAST(SYSUTCDATETIME() AS date)), 23);
  SET @sellers = @@ROWCOUNT;
  DELETE FROM lqdt.auctions
    WHERE status <> 'open' AND close_time_utc < DATEADD(day, -120, SYSDATETIMEOFFSET());
  SET @auctions = @@ROWCOUNT;
  SELECT @cron AS cron_runs, @sellers AS marketplace_sellers, @auctions AS auctions;
END;
```

### 5.4 `upsert_state_contracts_cost_aware(jsonb)` → `lqdt.sp_upsert_state_contracts` — the hard one
Pass the batch as a **JSON string** parsed with `OPENJSON` (replacing `jsonb_to_recordset`), MERGE on the 8-column key, and **only UPDATE when a business field actually differs** (the WAL-cost guard). Preserve `first_seen_date` by never updating it (mirrors the Supabase trigger). `WHEN MATCHED AND (…)` with `NULL`-safe comparisons reproduces `IS DISTINCT FROM`.

```sql
CREATE OR ALTER PROCEDURE lqdt.sp_upsert_state_contracts @rows NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  MERGE lqdt.state_contracts AS t
  USING (
    SELECT * FROM OPENJSON(@rows) WITH (
      state_code NVARCHAR(8), source_portal NVARCHAR(256), source_dataset_id NVARCHAR(256),
      contract_id NVARCHAR(256), vendor_name NVARCHAR(512), vendor_normalized NVARCHAR(512),
      customer_agency NVARCHAR(512), contract_title NVARCHAR(MAX), amount DECIMAL(18,2),
      year NVARCHAR(8), quarter NVARCHAR(8), period_start DATE, period_end DATE,
      record_type NVARCHAR(32), source_query NVARCHAR(MAX),
      first_seen_date NVARCHAR(10), last_seen_date NVARCHAR(10)
    )
  ) AS s
  ON  t.state_code = s.state_code AND t.source_dataset_id = s.source_dataset_id
  AND t.contract_id = s.contract_id AND t.vendor_normalized = s.vendor_normalized
  AND t.year = s.year AND t.quarter = s.quarter AND t.customer_agency = s.customer_agency
  AND t.record_type = COALESCE(s.record_type, 'payment')
  WHEN MATCHED AND EXISTS (
        SELECT t.source_portal, t.vendor_name, t.contract_title, t.amount,
               t.period_start, t.period_end, t.source_query
        EXCEPT
        SELECT s.source_portal, s.vendor_name, s.contract_title, s.amount,
               s.period_start, s.period_end, s.source_query
      ) THEN UPDATE SET
        source_portal = s.source_portal, vendor_name = s.vendor_name,
        contract_title = s.contract_title, amount = s.amount,
        period_start = s.period_start, period_end = s.period_end,
        source_query = s.source_query, last_seen_date = s.last_seen_date
        -- first_seen_date intentionally NOT updated (preserves original)
  WHEN NOT MATCHED THEN INSERT (
        state_code, source_portal, source_dataset_id, contract_id, vendor_name,
        vendor_normalized, customer_agency, contract_title, amount, year, quarter,
        period_start, period_end, record_type, source_query, first_seen_date, last_seen_date)
      VALUES (s.state_code, s.source_portal, s.source_dataset_id, s.contract_id, s.vendor_name,
        s.vendor_normalized, s.customer_agency, s.contract_title, s.amount, s.year, s.quarter,
        s.period_start, s.period_end, COALESCE(s.record_type,'payment'), s.source_query,
        s.first_seen_date, s.last_seen_date);
  SELECT @@ROWCOUNT AS affected;
END;
```
> `EXCEPT` gives NULL-safe difference detection (matches `IS DISTINCT FROM`). Always terminate MERGE with `;`. Under concurrency add `WITH (HOLDLOCK)` on the target and the 1205 retry (§7); state writes are single-threaded per run, so this is lower risk than `auctions`.

---

## 6. Access-layer rewrite

**New module** `src/lib/azure-tables.ts` (or grow `azure-sql.ts`) reusing the proven scaffolding: the lazy singleton `getPool()`, `isAzureSqlConfigured()`, parameterized `request().input(...)`, and the staging-heap→MERGE / deadlock-retry helpers (`mergeBatch`, `sqlErrorNumber`).

- **Delete `src/lib/supabase.ts`'s `createClient` calls.** Move the exported **row types** (`ListingRow`, `AuctionRow`, …) to a types-only module so consumers keep compiling. ⚠️ `createClient` runs at **import time** — the file must be gone (and all `import { supabase|supabaseAdmin }` removed) **before** the `SUPABASE_*` env vars / Dockerfile placeholders are dropped, or the next build crashes during page-data collection.
- **Reads to rewrite:** `dashboard-data.ts` (`getListings`/`getLatestListing`, `getContractsData` ×4 + seller snapshot, `getMarketplaceData` + the deltas view), `api/listings`, `api/data-status` (proc + fallback), `api/forecast` `loadBaseForecast` (snapshot read), `report-email.ts` `loadPreviousReportHeadline` (cron_runs), `email.ts` + `api/send-snapshot` (listings), and `auctions.ts` reads (`fetchAllAuctionRows`, `collectDebug`, `sweepClosures`).
- **Drop PostgREST paging:** `fetchAllAuctionRows` `.range()` loop + the scattered `.limit(1000)` exist only to beat PostgREST's 1000-row cap — remove them, but **re-add explicit `TOP`** where a limit was load-bearing (esp. `collectDebug`'s otherwise-unbounded scans).
- **jsonb boundary helpers:** `parseJson`/`stringifyJson` around `top_agencies`, `detail`, `payload`, `raw_data`.
- **Error-shape:** replace `{ data, error }` PostgREST branching with mssql try/catch. Sites that surface `error.message` (`/api/listings`) or branch on `error` for fallback (`data-status`, forecast) need re-checking against mssql errors.
- **Keep `ttlCache` unchanged** (transport-agnostic) — including the fix #1 `shouldCache: (f) => !f.store_degraded` guard on the forecast cache.
- **Read/write privilege split** (anon vs service) collapses to one `lqdt_app` login. Acceptable (server-only + Entra), but note the boundary now rests entirely on keeping the connection string server-side.

---

## 7. Write-path ports (all under `/api/cron`, + `fx.ts`, `cron-log.ts`)

| Write | Port |
|---|---|
| `auctions` open upsert **and** sold upsert (`auctions.ts:311,464`) | MERGE on `(platform, asset_id)` **`WITH (HOLDLOCK)` + 1205 deadlock retry** — two writers hit the same key in one run; reuse `mergeBatch` |
| `auctions` closure sweep (`sweepClosures`, `auctions.ts:325-362`) | replace read-ids-then-`UPDATE .in()` with a **single set-based `UPDATE … WHERE`** — removes the race window + 500-row chunking |
| `federal_contracts`, `sam_opportunities` (`ignoreDuplicates:true`) | **insert-only MERGE** (`WHEN NOT MATCHED THEN INSERT` only) — a WHEN-MATCHED branch would clobber `first_seen_date` |
| `listings`, `contract_snapshots`, `marketplace_sellers`, `fx_rates` | standard upsert MERGE on their unique keys (both branches) |
| `state_contracts` | call `lqdt.sp_upsert_state_contracts(@rows)` (§5.4). **Delete** the fallback plain-upsert branch (`cron/route.ts:296`) — dead once ported |
| `forecast_snapshots` (`cron/route.ts:333`) | MERGE on `quarter`. **Now actually persists** → revives the fast path |
| `cron_runs` insert (`cron-log.ts:97`) | batch INSERT. **Now actually persists**. Keep the **never-throw** contract |
| `fx_rates` (`fx.ts:110`) | MERGE on `(date, currency)`; keep never-throw |
| retention (`run_cost_retention`) | new daily cron task calling `lqdt.sp_run_cost_retention` (gated like other daily work) |

**Never-throw contract:** `fx_rates`, `cron_runs`, and the `forecast_snapshots` write are best-effort today (swallowed). The Azure equivalents must keep that — an audit/log write must never fail the ingestion run.

---

## 8. One-time data copy (must-copy tables only)

**Mechanism:** a Node script (`scripts/migrate-supabase-to-azure.mjs`) using `@supabase/supabase-js` to read (**paginated with `.range()`** — the 1000-row cap silently truncates otherwise) → Azure `mssql` via the staging→MERGE path.

- **Tables:** `state_contracts`, `marketplace_sellers`, `federal_contracts`, `sam_opportunities`, `listings`, `contract_snapshots`, `fx_rates`.
- **Not copied:** `auctions` (re-derive), `forecast_snapshots` + `cron_runs` (empty; also unreadable via PostgREST anyway), `marketplace_metrics` (drop).
- **Freeze vs delta:** the cron writes every 4h. Either pause the `lqdt-cron`/`lqdt-sold-capture` jobs for the copy window, or copy then run a final catch-up delta right before cutover. Recommended: copy → verify → brief job pause → final delta → flip.
- **Parity check per table:** `COUNT(*)` and `MAX(date/first_seen_date)` on both sides, plus a spot `SUM(amount)` for `state_contracts`. Copy is idempotent (MERGE), so re-runnable.
- ⚠️ Live row counts weren't measurable in this environment (Supabase not authenticated) — run `COUNT(*)` first to size the copy.

---

## 9. Cutover runbook (phased, reversible)

- **Phase 0 — schema:** apply `azure-sql/005–014` + the procs/view. Add a minimal **migration checklist/runner** (today the files are hand-run with undocumented ordering — the code only survives gaps via error-208 catches; more tables widen that risk).
- **Phase 1 — access layer behind a flag:** implement the Azure read/write layer gated by `DATA_BACKEND=supabase|azure` (default `supabase`). Both paths compile; flip per-environment. This is the rollback lever.
- **Phase 2 — verify on preview:** point a preview deployment at `DATA_BACKEND=azure` and diff every page (overview, contracts, marketplace, forecast, QTD) + `/api/data-status` + a report preview against Supabase-backed prod.
- **Phase 3 — copy:** run §8 for the must-copy tables; confirm parity.
- **Phase 4 — cutover:** set `DATA_BACKEND=azure` in prod. Disposable tables refill on the next cron. **Verify:** forecast fast-path alive (snapshot now written), `cron_runs` logging, data-status green, report "since last report" deltas populate, Gov Sellers + seller-movers render.
- **Phase 5 — decommission (after a few days' soak):** remove `@supabase/supabase-js`, `src/lib/supabase.ts`, the three env vars, Dockerfile placeholders, and the `build-container.yml` Supabase wiring. Keep `supabase/migrations/` as history. Retire the `DATA_BACKEND` flag.

**Rollback:** any time before Phase 5, set `DATA_BACKEND=supabase` — Supabase stays intact and (until Phase 5) is still being written, so it's a live fallback during the soak.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **jsonb round-trip** (payload/detail/top_agencies) — mssql returns raw strings | explicit parse/stringify helpers at the boundary; `ISJSON` CHECK constraints |
| **Reviving dead tables** silently changes behavior (forecast fast-path, logging, deltas) | functional checks in Phase 4, not just schema checks; keep the live-compute fallback in `/api/forecast` |
| **`auctions` MERGE deadlocks** (3 writers, one key) | `HOLDLOCK` + 1205 retry (proven pattern); set-based sweep removes the read-write race |
| **Insert-only semantics** lost (`federal`, `sam`) | MERGE without a WHEN-MATCHED branch |
| **Cost-aware upsert** degrades to full rewrites | `EXCEPT`-based is-distinct guard in `sp_upsert_state_contracts` |
| **Text date columns** auto-converted to `DATE` | keep them `NVARCHAR`; only `period_start/end` are real `DATE` |
| **PostgREST 1000-row truncation** during copy | paginate with `.range()`; parity `COUNT(*)` |
| **No Azure migration runner** | add a checklist/runner in Phase 0 |
| **S2 DTU ceiling** — the dense-month read already brushes the timeout; `auctions` adds churn | keep the indexes above; watch DTU; `pool.max` stays modest; the "optimize on S2 first" decision means we monitor and scale only if needed |
| **Retention no longer automatic** (was pg-invoked) | daily cron task → `sp_run_cost_retention`, or the tables grow unbounded |
| **Removing env vars before deleting `supabase.ts`** crashes the build | order Phase 5 strictly: code first, then env/Dockerfile |

---

## 11. Effort / sequencing

Phases 0–1 are the bulk (schema + procs + the access-layer rewrite across ~9 files + the cost-aware proc). Phase 2 verification and Phase 3 copy are mechanical. Phase 4 is a flag flip; Phase 5 is cleanup. The `DATA_BACKEND` flag makes the whole thing incrementally shippable and reversible despite being specced as one plan.

## 12. Open items to confirm before execution
1. **Drop confirmations:** `marketplace_metrics` (no code refs) and `auction_daily_stats` (unused) — OK to drop, not port?
2. **`DATA_BACKEND` flag** vs a straight rewrite-and-cutover (flag adds temporary dual-path code but gives clean rollback) — keep the flag?
3. **Copy freeze window:** OK to briefly pause the cron jobs during the final data copy, or prefer the copy-then-delta approach?
4. **S2 monitoring:** acceptable to proceed on S2 and add a DTU alert, revisiting the tier only if the `auctions` churn + reads push contention?
