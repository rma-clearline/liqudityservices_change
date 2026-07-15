-- Azure SQL (cl-sql-db) — Maestro enrichment columns on the sold-lot store.
-- Engine: Azure SQL Database (T-SQL). Runs as lqdt_app (owns the lqdt schema —
-- no admin needed). Idempotent: each ADD is guarded by a COL_LENGTH check.
--
-- New fields captured from the Maestro sold feed (verified 100% populated by a
-- live probe except category_routepath, which the feed currently returns as
-- NULL — captured anyway so we pick it up if Maestro ever populates it):
--   opening_bid_native/usd  assetBidPrice — the seller's opening/minimum bid.
--                           hammer ÷ opening = competitive-intensity signal.
--   is_sold_auction         isSoldAuction — ground-truth sold flag (vs the
--                           bid_count>0 heuristic elsewhere).
--   asset_status_cd         assetStatusCd — e.g. SOA (sold), STA (active).
--   start_time_et           assetAuctionStartDate — naive ET wall clock as the
--                           feed provides it (no UTC variant exists for start).
--                           Enables listing-duration and forward-supply cohorts.
--   category_code           assetCategory — stable alphanumeric taxonomy code
--                           (e.g. "80", "95F"), sturdier than the description.
--   category_routepath      categoryRoutepath — taxonomy path (feed: NULL today).

IF COL_LENGTH('lqdt.sold_lots', 'opening_bid_native') IS NULL
  ALTER TABLE lqdt.sold_lots ADD
    opening_bid_native DECIMAL(19,4) NULL,
    opening_bid_usd    DECIMAL(19,4) NULL,
    is_sold_auction    BIT           NULL,
    asset_status_cd    NVARCHAR(8)   NULL,
    start_time_et      DATETIME2(0)  NULL,
    category_code      NVARCHAR(16)  NULL,
    category_routepath NVARCHAR(400) NULL;
GO

IF COL_LENGTH('lqdt.sold_lots_staging', 'opening_bid_native') IS NULL
  ALTER TABLE lqdt.sold_lots_staging ADD
    opening_bid_native DECIMAL(19,4) NULL,
    opening_bid_usd    DECIMAL(19,4) NULL,
    is_sold_auction    BIT           NULL,
    asset_status_cd    NVARCHAR(8)   NULL,
    start_time_et      DATETIME2(0)  NULL,
    category_code      NVARCHAR(16)  NULL,
    category_routepath NVARCHAR(400) NULL;
GO
