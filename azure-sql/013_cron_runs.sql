-- Supabase→Azure migration, table 9/10: cron_runs.
-- Per-source cron run log (one row per source per run + a '__run__' summary).
-- CREATE EMPTY: history disposable; logging resumes fresh. detail is JSON.
-- NOTE: dead in Supabase today (PGRST205) — activating this restores the run
-- log, the data-status freshness banner, and the report's "since last report".

IF OBJECT_ID('lqdt.cron_runs', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.cron_runs (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_cron_runs PRIMARY KEY,
    run_id        UNIQUEIDENTIFIER NOT NULL,
    source        NVARCHAR(64)  NOT NULL,
    status        NVARCHAR(16)  NOT NULL CONSTRAINT CK_cron_status CHECK (status IN ('success','partial','failed','skipped')),
    rows_ingested INT           NULL,
    detail        NVARCHAR(MAX) NULL CONSTRAINT CK_cron_detail CHECK (detail IS NULL OR ISJSON(detail) = 1),
    error         NVARCHAR(MAX) NULL,
    started_at    DATETIME2(3)  NOT NULL,
    ended_at      DATETIME2(3)  NULL,
    duration_ms   INT           NULL,
    created_at    DATETIME2(3)  NOT NULL CONSTRAINT DF_cron_created DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_cron_started        ON lqdt.cron_runs (started_at DESC);
  CREATE INDEX IX_cron_source_started ON lqdt.cron_runs (source, started_at DESC);
END
GO
