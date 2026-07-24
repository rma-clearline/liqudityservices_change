-- Supabase→Azure migration, table 8/10: auctions.
-- Auction-level tracking for the revenue forecast (open + closed lifecycle).
-- CREATE EMPTY: this is a lossy duplicate of lqdt.sold_lots and refills from the
-- cron on the next run — it is NOT data-migrated. Upsert on (platform, asset_id)
-- via MERGE + HOLDLOCK + deadlock retry in the access layer. Timestamps are
-- DATETIME2 (UTC); the access layer converts to/from ISO strings for AuctionRow.

IF OBJECT_ID('lqdt.auctions', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.auctions (
    id                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_auctions PRIMARY KEY,
    platform          NVARCHAR(2)   NOT NULL CONSTRAINT CK_auc_platform CHECK (platform IN ('AD','GD')),
    asset_id          NVARCHAR(128) NOT NULL,
    seller_account_id NVARCHAR(128) NULL,
    seller_company    NVARCHAR(512) NULL,
    category          NVARCHAR(256) NULL,
    currency_code     NVARCHAR(8)   NULL,
    current_bid_usd   REAL          NULL,
    bid_count         INT           NULL,
    close_time_utc    DATETIME2(0)  NULL,
    status            NVARCHAR(16)  NOT NULL CONSTRAINT DF_auc_status DEFAULT 'open'
                        CONSTRAINT CK_auc_status CHECK (status IN ('open','closed_sold','closed_nosale','unknown')),
    final_price_usd   REAL          NULL,
    first_seen_at     DATETIME2(3)  NOT NULL CONSTRAINT DF_auc_first_seen DEFAULT SYSUTCDATETIME(),
    last_seen_at      DATETIME2(3)  NOT NULL CONSTRAINT DF_auc_last_seen  DEFAULT SYSUTCDATETIME(),
    closed_at         DATETIME2(0)  NULL,
    created_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_auc_created    DEFAULT SYSUTCDATETIME(),
    -- enrichment (Supabase migration 013)
    title             NVARCHAR(MAX) NULL,
    country           NVARCHAR(128) NULL,
    state             NVARCHAR(128) NULL,
    city              NVARCHAR(256) NULL,
    make              NVARCHAR(256) NULL,
    model             NVARCHAR(256) NULL,
    model_year        NVARCHAR(16)  NULL,
    lot_number        NVARCHAR(64)  NULL,
    keywords          NVARCHAR(MAX) NULL,
    url               NVARCHAR(MAX) NULL,
    event_id          NVARCHAR(64)  NULL,
    auction_type_id   NVARCHAR(64)  NULL,
    row_business_id   NVARCHAR(8)   NULL,
    reserve_status    NVARCHAR(32)  NULL,
    is_new_asset      BIT           NULL,
    sale_amount_native DECIMAL(18,2) NULL,
    fx_rate_used      REAL          NULL,
    fx_source         NVARCHAR(64)  NULL,
    watch_count       INT           NULL,
    CONSTRAINT UQ_auc_platform_asset UNIQUE (platform, asset_id)
  );
  CREATE INDEX IX_auc_open_close   ON lqdt.auctions (close_time_utc) WHERE status = 'open';
  CREATE INDEX IX_auc_status_close ON lqdt.auctions (status, close_time_utc DESC);
  CREATE INDEX IX_auc_seller       ON lqdt.auctions (seller_account_id, platform);
END
GO
