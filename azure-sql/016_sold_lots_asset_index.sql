-- Covering index on the relist identity, for the supersession refresh.
--
-- The refresh partitions by (site, account_id, asset_id) to find a relisted asset's
-- attempts, but the only indexes were the clustered (close_date_et, site) and the
-- PK on row_key — so every refresh scanned all ~810k rows. On 2026-08-06 the noon
-- refresh crossed the 120s mssql requestTimeout and was killed mid-flight, which
-- made the forecast-snapshot guard skip the snapshot ("supersession refresh failed").
-- The exact 120.0s gap between the auctions task ending and the snapshot task
-- starting is what identified it.
--
-- INCLUDEs make both the candidate lookup and the ROW_NUMBER/FIRST_VALUE ranking
-- index-only: auction_id and close_time_utc are the ORDER BY, superseded_by_auction
-- is the compared value, row_key is the join key back to the table.

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_sold_lots_asset' AND object_id = OBJECT_ID('lqdt.sold_lots'))
  CREATE INDEX IX_sold_lots_asset
    ON lqdt.sold_lots (site, account_id, asset_id)
    INCLUDE (auction_id, close_time_utc, superseded_by_auction, row_key);
GO
