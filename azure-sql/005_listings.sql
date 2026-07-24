-- Azure SQL (cl-sql-db) — Supabase→Azure migration, table 1/10: listings.
-- Engine: Azure SQL Database (T-SQL). Runs as lqdt_app (owns the lqdt schema +
-- has CREATE TABLE — no admin needed). Idempotent: guarded by OBJECT_ID.
--
-- Daily count of live lots on AllSurplus + GovDeals (one row/day). `date` and
-- `timestamp` stay NVARCHAR — the app compares/sorts them as ISO strings.

IF OBJECT_ID('lqdt.listings', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.listings (
    id         BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_listings PRIMARY KEY,
    date       NVARCHAR(10) NOT NULL,
    timestamp  NVARCHAR(8)  NULL,
    allsurplus INT          NULL,
    govdeals   INT          NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_listings_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_listings_date UNIQUE (date)
  );
END
GO
