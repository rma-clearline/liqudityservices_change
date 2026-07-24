-- Supabase→Azure migration, table 7/10: fx_rates.
-- USD FX rate audit trail (units of `currency` per 1 USD). Upsert on (date,currency).

IF OBJECT_ID('lqdt.fx_rates', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.fx_rates (
    id           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_fx_rates PRIMARY KEY,
    date         NVARCHAR(10) NOT NULL,
    currency     NVARCHAR(8)  NOT NULL,
    usd_per_unit REAL         NOT NULL,
    source       NVARCHAR(64) NOT NULL,
    fetched_at   DATETIME2(3) NOT NULL CONSTRAINT DF_fx_fetched DEFAULT SYSUTCDATETIME(),
    created_at   DATETIME2(3) NOT NULL CONSTRAINT DF_fx_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_fx_date_currency UNIQUE (date, currency)
  );
  CREATE INDEX IX_fx_ccy_date ON lqdt.fx_rates (currency, date DESC);
END
GO
