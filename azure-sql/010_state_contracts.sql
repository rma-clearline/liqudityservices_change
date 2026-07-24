-- Supabase→Azure migration, table 6/10: state_contracts.
-- State/local contract + payment records. Largest reference set. Written via the
-- cost-aware MERGE (OPENJSON) in the access layer, which preserves first_seen_date
-- (replacing the Postgres BEFORE-UPDATE trigger). raw_data is JSON but nulled today.
-- period_start/period_end are real dates; year/quarter/*_date stay NVARCHAR.

IF OBJECT_ID('lqdt.state_contracts', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.state_contracts (
    id                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_state_contracts PRIMARY KEY,
    state_code        NVARCHAR(8)   NOT NULL,
    source_portal     NVARCHAR(256) NULL,
    source_dataset_id NVARCHAR(256) NOT NULL,
    contract_id       NVARCHAR(256) NOT NULL,
    vendor_name       NVARCHAR(512) NULL,
    vendor_normalized NVARCHAR(512) NOT NULL,
    customer_agency   NVARCHAR(512) NOT NULL,
    contract_title    NVARCHAR(MAX) NULL,
    amount            DECIMAL(18,2) NULL,
    year              NVARCHAR(8)   NOT NULL,
    quarter           NVARCHAR(8)   NOT NULL,
    period_start      DATE          NULL,
    period_end        DATE          NULL,
    record_type       NVARCHAR(32)  NOT NULL CONSTRAINT DF_sc_record_type DEFAULT 'payment',
    raw_data          NVARCHAR(MAX) NULL,
    source_query      NVARCHAR(MAX) NULL,
    first_seen_date   NVARCHAR(10)  NOT NULL,
    last_seen_date    NVARCHAR(10)  NULL,
    created_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_sc_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_sc_natural UNIQUE
      (state_code, source_dataset_id, contract_id, vendor_normalized, year, quarter, customer_agency, record_type)
  );
END
GO
