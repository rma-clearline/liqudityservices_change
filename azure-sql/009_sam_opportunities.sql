-- Supabase→Azure migration, table 5/10: sam_opportunities.
-- SAM.gov solicitations/opportunities. Insert-only (dedup on notice_id).

IF OBJECT_ID('lqdt.sam_opportunities', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.sam_opportunities (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_sam_opportunities PRIMARY KEY,
    notice_id           NVARCHAR(256) NOT NULL,
    title               NVARCHAR(MAX) NULL,
    solicitation_number NVARCHAR(256) NULL,
    organization        NVARCHAR(512) NULL,
    posted_date         NVARCHAR(10)  NULL,
    response_deadline   NVARCHAR(32)  NULL,
    notice_type         NVARCHAR(128) NULL,
    base_type           NVARCHAR(128) NULL,
    naics_code          NVARCHAR(32)  NULL,
    classification_code NVARCHAR(32)  NULL,
    description_url     NVARCHAR(MAX) NULL,
    ui_link             NVARCHAR(MAX) NULL,
    awardee_name        NVARCHAR(512) NULL,
    awardee_uei         NVARCHAR(64)  NULL,
    award_amount        DECIMAL(18,2) NULL,
    award_date          NVARCHAR(10)  NULL,
    set_aside           NVARCHAR(256) NULL,
    pop_state           NVARCHAR(128) NULL,
    pop_city            NVARCHAR(256) NULL,
    first_seen_date     NVARCHAR(10)  NOT NULL,
    created_at          DATETIME2(3)  NOT NULL CONSTRAINT DF_sam_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_sam_notice_id UNIQUE (notice_id)
  );
  CREATE INDEX IX_sam_posted ON lqdt.sam_opportunities (posted_date DESC);
END
GO
