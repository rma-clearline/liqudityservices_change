-- Run ONCE as an admin (sqladmin SQL auth or the Entra admin) — e.g. Azure
-- portal > cl-sql-db > Query editor. Two things:
--
-- 1) The analyst estimate-override table. lqdt_app owns the lqdt schema
--    (001_create_sold_lots.sql) but was never granted database-level CREATE
--    TABLE, so the app's self-bootstrap (ensureModelEstimatesTable in
--    src/lib/azure-sql.ts) can't create it — an admin must, once. Schema
--    ownership gives lqdt_app full rights on the table once it exists.
--
-- 2) GRANT CREATE TABLE, fixing that gap for good: with it, future lqdt.*
--    tables self-bootstrap from the app and no admin run is needed again
--    (this was 001's stated intent — schema ownership alone wasn't enough).
--
-- The table holds per-quarter overrides for company guidance / the Clearline
-- GMV estimate, entered from the QTD page (/api/model-estimates). A row here
-- overrides that quarter's values from the model-workbook export; deleting it
-- reverts them.

IF OBJECT_ID('lqdt.model_estimates', 'U') IS NULL
CREATE TABLE lqdt.model_estimates (
  quarter                 char(6)       NOT NULL PRIMARY KEY,
  guidance_low_usd        bigint        NULL,
  guidance_high_usd       bigint        NULL,
  clearline_estimate_usd  bigint        NULL,
  updated_by              nvarchar(256) NULL,
  updated_at              datetime2(0)  NOT NULL DEFAULT sysutcdatetime()
);
GO

GRANT CREATE TABLE TO lqdt_app;
GO
