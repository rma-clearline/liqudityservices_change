-- Supabase→Azure migration, table 10/10: forecast_snapshots.
-- Current-quarter forecast materialized by the daily reconciliation (keeps
-- interactive reads off a live recompute while /api/forecast retains its live
-- fallback). CREATE EMPTY: the cron regenerates it. payload is the JSON
-- RevenueValueForecast blob (app JSON.parse/stringify's at the boundary).
-- NOTE: dead in Supabase today (PGRST205) — activating this restores the
-- forecast fast path.

IF OBJECT_ID('lqdt.forecast_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.forecast_snapshots (
    quarter      NVARCHAR(16)  NOT NULL CONSTRAINT PK_forecast_snapshots PRIMARY KEY,
    payload      NVARCHAR(MAX) NOT NULL CONSTRAINT CK_fs_payload CHECK (ISJSON(payload) = 1),
    generated_at DATETIME2(3)  NOT NULL CONSTRAINT DF_fs_generated DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_fs_generated ON lqdt.forecast_snapshots (generated_at DESC);
END
GO
