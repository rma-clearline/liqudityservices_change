-- Azure SQL (cl-sql-db) — durable per-lot sold store for the LQDT dashboard.
-- Engine: Azure SQL Database (T-SQL), NOT Postgres. Run once as an admin
-- (sqladmin SQL auth or the Entra admin). The app connects as the least-
-- privilege contained user `lqdt_app`, which OWNS the lqdt schema so future
-- migrations run as lqdt_app without needing admin again.
--
-- Mirrors the export's per-lot shape (SoldExportRow) 1:1. Identity is the export's
-- own dedup key: rowKey = site:account_id:asset_id:auction_id. NOTE: asset_id and
-- auction_id are only unique WITHIN a seller account (GovDeals reuses small asset
-- numbers across agencies), so account_id + site are required in the key — keying
-- on (asset_id, auction_id) alone silently merges distinct lots.

-- 1) Dedicated schema.
IF SCHEMA_ID('lqdt') IS NULL EXEC('CREATE SCHEMA lqdt');
GO

-- 2) Least-privilege app user (contained SQL user; password injected from .env at
--    run time — the committed file carries only a placeholder). Skipped if it
--    already exists.
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'lqdt_app')
  CREATE USER lqdt_app WITH PASSWORD = '<<AZURE_SQL_PASSWORD>>';
GO

GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::lqdt TO lqdt_app;
GO
-- Make lqdt_app the schema owner so it can create/alter/drop its OWN tables
-- (scoped to lqdt only) — no more admin round-trips for future migrations.
ALTER AUTHORIZATION ON SCHEMA::lqdt TO lqdt_app;
GO

-- 3) The sold-lot table.
IF OBJECT_ID('lqdt.sold_lots', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.sold_lots (
    row_key            NVARCHAR(220)  NOT NULL,   -- site:account_id:asset_id:auction_id (export rowKey)
    asset_id           NVARCHAR(64)   NOT NULL,
    auction_id         NVARCHAR(64)   NOT NULL,
    account_id         NVARCHAR(64)   NULL,
    site               NVARCHAR(8)    NOT NULL,   -- AD/GD/GI (true marketplace)
    platform           NVARCHAR(8)    NULL,       -- raw feed platform (diagnostic)
    seller             NVARCHAR(256)  NULL,
    seller_type        NVARCHAR(16)   NULL,       -- government | retail
    gov_level          NVARCHAR(16)   NULL,       -- federal | state | local | commercial
    title              NVARCHAR(512)  NULL,
    category           NVARCHAR(160)  NULL,
    country            NVARCHAR(96)   NULL,
    state              NVARCHAR(96)   NULL,
    market             NVARCHAR(16)   NULL,       -- domestic | international
    currency_code      NVARCHAR(8)    NULL,
    sale_amount_native DECIMAL(19,4)  NULL,
    sale_amount_usd    DECIMAL(19,4)  NULL,
    bid_count          INT            NULL,
    url                NVARCHAR(1024) NULL,
    close_time_utc     DATETIME2(0)   NULL,
    close_date_et      DATE           NOT NULL,   -- ET day the lot closed (bucketing key)
    ingested_at        DATETIME2(3)   NOT NULL CONSTRAINT DF_sold_lots_ingested DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_sold_lots PRIMARY KEY NONCLUSTERED (row_key)
  );

  -- Reads are overwhelmingly date-range scans (then filter by site/category),
  -- so cluster on (close_date_et, site).
  CREATE CLUSTERED INDEX CIX_sold_lots_date_site ON lqdt.sold_lots (close_date_et, site);
  CREATE INDEX IX_sold_lots_close_time ON lqdt.sold_lots (close_time_utc);
  CREATE INDEX IX_sold_lots_category   ON lqdt.sold_lots (category);
END
GO

-- 4) Staging heap for bulk-load → MERGE. Writers bulk a chunk under their own
--    batch_id, MERGE it into sold_lots, then delete that batch — so a backfill and
--    the daily cron can never step on each other's rows.
IF OBJECT_ID('lqdt.sold_lots_staging', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.sold_lots_staging (
    batch_id           UNIQUEIDENTIFIER NOT NULL,
    row_key            NVARCHAR(220)  NOT NULL,
    asset_id           NVARCHAR(64)   NOT NULL,
    auction_id         NVARCHAR(64)   NOT NULL,
    account_id         NVARCHAR(64)   NULL,
    site               NVARCHAR(8)    NOT NULL,
    platform           NVARCHAR(8)    NULL,
    seller             NVARCHAR(256)  NULL,
    seller_type        NVARCHAR(16)   NULL,
    gov_level          NVARCHAR(16)   NULL,
    title              NVARCHAR(512)  NULL,
    category           NVARCHAR(160)  NULL,
    country            NVARCHAR(96)   NULL,
    state              NVARCHAR(96)   NULL,
    market             NVARCHAR(16)   NULL,
    currency_code      NVARCHAR(8)    NULL,
    sale_amount_native DECIMAL(19,4)  NULL,
    sale_amount_usd    DECIMAL(19,4)  NULL,
    bid_count          INT            NULL,
    url                NVARCHAR(1024) NULL,
    close_time_utc     DATETIME2(0)   NULL,
    close_date_et      DATE           NOT NULL
  );
  CREATE INDEX IX_sold_lots_staging_batch ON lqdt.sold_lots_staging (batch_id);
END
GO
