-- Supabase→Azure migration, table 4/10: contract_snapshots.
-- Daily rollup of the federal-contracts fetch. top_agencies is JSON
-- (NVARCHAR(MAX)) — the app JSON.parse/stringify's it at the mssql boundary.

IF OBJECT_ID('lqdt.contract_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.contract_snapshots (
    id                      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_contract_snapshots PRIMARY KEY,
    date                    NVARCHAR(10)  NOT NULL,
    total_active_contracts  INT           NULL,
    total_obligated_amount  REAL          NULL,
    new_contracts_last_30d  INT           NULL,
    new_obligation_last_30d REAL          NULL,
    top_agencies            NVARCHAR(MAX) NULL CONSTRAINT CK_cs_top_agencies CHECK (top_agencies IS NULL OR ISJSON(top_agencies) = 1),
    created_at              DATETIME2(3)  NOT NULL CONSTRAINT DF_cs_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_cs_date UNIQUE (date)
  );
END
GO
