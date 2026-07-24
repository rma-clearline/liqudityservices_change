-- Supabase→Azure migration, table 3/10: federal_contracts.
-- USAspending federal award records. Insert-only (dedup on award_id).

IF OBJECT_ID('lqdt.federal_contracts', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.federal_contracts (
    id                         BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_federal_contracts PRIMARY KEY,
    award_id                   NVARCHAR(256) NOT NULL,
    recipient_name             NVARCHAR(512) NULL,
    award_amount               REAL          NULL,
    total_obligation           REAL          NULL,
    awarding_agency            NVARCHAR(512) NULL,
    funding_agency             NVARCHAR(512) NULL,
    award_type                 NVARCHAR(128) NULL,
    start_date                 NVARCHAR(10)  NULL,
    end_date                   NVARCHAR(10)  NULL,
    description                NVARCHAR(MAX) NULL,
    place_of_performance_state NVARCHAR(128) NULL,
    naics_code                 NVARCHAR(32)  NULL,
    first_seen_date            NVARCHAR(10)  NOT NULL,
    created_at                 DATETIME2(3)  NOT NULL CONSTRAINT DF_fc_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_fc_award_id UNIQUE (award_id)
  );
  CREATE INDEX IX_fc_start ON lqdt.federal_contracts (start_date DESC);
END
GO
