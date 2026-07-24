-- Supabase→Azure migration, table 2/10: marketplace_sellers.
-- Per-day per-seller marketplace snapshot (Gov Sellers widget + Marketplace tab,
-- and the base for the marketplace_seller_deltas query). 548-day retention.

IF OBJECT_ID('lqdt.marketplace_sellers', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.marketplace_sellers (
    id                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_marketplace_sellers PRIMARY KEY,
    date              NVARCHAR(10)  NOT NULL,
    platform          NVARCHAR(2)   NOT NULL CONSTRAINT CK_ms_platform CHECK (platform IN ('AD','GD')),
    account_id        NVARCHAR(128) NOT NULL,
    company_name      NVARCHAR(512) NULL,
    country           NVARCHAR(128) NULL,
    state             NVARCHAR(128) NULL,
    listing_count     INT           NULL,
    total_current_bid REAL          NULL,
    total_bids        INT           NULL,
    top_bid_asset_id  NVARCHAR(128) NULL,
    sub_business_id   NVARCHAR(128) NULL,
    created_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_ms_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ms_date_platform_account UNIQUE (date, platform, account_id)
  );
  CREATE INDEX IX_ms_date_bid ON lqdt.marketplace_sellers (date, total_current_bid DESC);
END
GO
