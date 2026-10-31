-- Invaluable / AuctionZip panel tracker (permission-based collection, 2026-10-30).
-- A panel of auction houses whose hosted catalogs are collected in full via the open
-- catalog + lot APIs. Per lot we keep the posted result, the platform's top online bid
-- and the derived online-won flag (online bid x (1+premium) == result), which is the
-- quantity Invaluable reports as GMS. Native currency; FX later. Idempotent.
IF OBJECT_ID('lqdt.inv_houses','U') IS NULL
CREATE TABLE lqdt.inv_houses (
  house_key NVARCHAR(40) NOT NULL CONSTRAINT PK_inv_houses PRIMARY KEY,
  name NVARCHAR(200) NULL, domain NVARCHAR(200) NOT NULL, kind NVARCHAR(20) NOT NULL,
  seller_id INT NULL, seller_ref NVARCHAR(20) NULL,
  added_at DATETIME2(0) NOT NULL CONSTRAINT DF_inv_houses_added DEFAULT SYSUTCDATETIME());
GO
IF OBJECT_ID('lqdt.inv_catalogs','U') IS NULL
CREATE TABLE lqdt.inv_catalogs (
  catalog_ref NVARCHAR(20) NOT NULL CONSTRAINT PK_inv_catalogs PRIMARY KEY,
  house_key NVARCHAR(40) NOT NULL, title NVARCHAR(300) NULL, path NVARCHAR(400) NULL,
  event_date_local DATE NULL, event_ts_utc DATETIME2(0) NULL,
  is_live BIT NULL, is_timed BIT NULL, results_include_premium BIT NULL,
  premium_rate DECIMAL(6,4) NULL, currency NVARCHAR(8) NULL,
  nb_lots INT NULL, lots_fetched INT NOT NULL CONSTRAINT DF_inv_cat_lf DEFAULT 0,
  status NVARCHAR(20) NOT NULL,
  fetched_at DATETIME2(0) NOT NULL CONSTRAINT DF_inv_cat_fetched DEFAULT SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_inv_catalogs_house_date')
  CREATE INDEX IX_inv_catalogs_house_date ON lqdt.inv_catalogs(house_key, event_date_local);
GO
IF OBJECT_ID('lqdt.inv_lots','U') IS NULL
CREATE TABLE lqdt.inv_lots (
  lot_ref NVARCHAR(20) NOT NULL CONSTRAINT PK_inv_lots PRIMARY KEY,
  lot_id BIGINT NULL, catalog_ref NVARCHAR(20) NOT NULL, lot_number NVARCHAR(20) NULL,
  title NVARCHAR(400) NULL, category NVARCHAR(120) NULL, subcategory NVARCHAR(120) NULL,
  estimate_low DECIMAL(18,2) NULL, estimate_high DECIMAL(18,2) NULL,
  is_sold BIT NULL, is_passed BIT NULL,
  price_result DECIMAL(18,2) NULL, premium_rate DECIMAL(6,4) NULL, hammer DECIMAL(18,2) NULL,
  online_all_in DECIMAL(18,2) NULL, online_hammer DECIMAL(18,2) NULL, bid_count INT NULL,
  online_won BIT NULL, currency NVARCHAR(8) NULL,
  fetched_at DATETIME2(0) NOT NULL CONSTRAINT DF_inv_lots_fetched DEFAULT SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_inv_lots_catalog')
  CREATE INDEX IX_inv_lots_catalog ON lqdt.inv_lots(catalog_ref);
GO
-- NOTE: lqdt_app has no CREATE VIEW right, so the monthly aggregate (per house, per
-- month: catalogs, lots, sold, THV, online-won, timed THV over status=complete catalogs)
-- lives as a query in scripts/invaluable/db.mjs (monthlySummary) rather than as a view.
