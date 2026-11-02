-- Invaluable panel: pre-aggregated house-month rollup (2026-11-02).
-- The /api/invaluable page recomputed its series from every lot in lqdt.inv_lots on
-- each cold cache: a scan + row-level FX subquery over ~240k lots that saturates the
-- shared S2 database (a bare count took ~90 s), so the page timed out at 120 s.
-- This table holds the exact output of the API's HOUSE_MONTH_SQL, one row per house
-- and month, in USD. The collector refreshes it after each run (db.mjs refreshRollup);
-- the API reads these few hundred rows and rolls months into quarters in code.
-- Idempotent. lqdt_app has table DDL but no CREATE VIEW, hence a table, not a view.
IF OBJECT_ID('lqdt.inv_house_month','U') IS NULL
CREATE TABLE lqdt.inv_house_month (
  house_key NVARCHAR(40) NOT NULL,
  month CHAR(7) NOT NULL,              -- YYYY-MM (calendar)
  sold INT NOT NULL,
  thv_usd DECIMAL(18,2) NOT NULL,
  online_usd DECIMAL(18,2) NOT NULL,
  online_lots INT NOT NULL,
  online_loose_usd DECIMAL(18,2) NOT NULL,
  timed_usd DECIMAL(18,2) NOT NULL,
  refreshed_at DATETIME2(0) NOT NULL CONSTRAINT DF_inv_hm_refreshed DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_inv_house_month PRIMARY KEY (house_key, month));
GO
