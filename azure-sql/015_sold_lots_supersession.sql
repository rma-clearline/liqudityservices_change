-- 015: relist supersession for lqdt.sold_lots
--
-- WHY. row_key is site:account_id:asset_id:auction_id. When a marketplace asset sells but
-- the sale does not complete (bidder defaults, sale voided), it is relisted and resold
-- under a NEW auctionId, so every attempt persisted as its own row and ALL of them counted
-- toward GMV. One 2015 Ford F-150 (GD asset 1093, account 5701) was stored three times:
-- auction 1 $1,946, auction 2 $3,218,754 (a corrupt bidder ID, see the parseSale guard in
-- src/lib/historical-sales.ts), auction 3 $946. LSI counts "transactions for which we
-- earned compensation upon their completion", so only the final sale is real GMV.
--
-- Measured overstatement when this was introduced: $4.6M of $961.1M store-wide (0.48%),
-- concentrated entirely in the daily-capture era — 2026Q2 -1.03% and 2026Q3 -2.58%, while
-- 2025Q3/2025Q4/2026Q1 moved 0.00%. Those earlier quarters were backfilled over WIDE
-- windows, and a wide-window Maestro sold search returns only the latest auction record
-- per asset, so the source deduped them for us. Per-day fetches do not.
--
-- HOW. Rows are only ever MARKED, never deleted or nulled, so every relist attempt stays
-- intact for audit. Reads go through the SOLD_CURRENT derived table in src/lib/azure-sql.ts
-- (a constant, not a view: lqdt_app has ALTER on the schema but is denied database-level
-- CREATE VIEW). refreshSoldSupersession() maintains the marker and runs after every sold
-- capture (cron) and after /api/backfill-sold.
--
-- This file documents the schema change for the record; the application also applies it
-- idempotently at pool open (ensureSupersession), so no manual step is required.

IF COL_LENGTH('lqdt.sold_lots', 'superseded_by_auction') IS NULL
  ALTER TABLE lqdt.sold_lots ADD superseded_by_auction nvarchar(64) NULL;
GO

-- Backfill / recompute. Idempotent and ingest-order independent: ranking is by the actual
-- sale time, so a late-arriving OLDER record cannot win. The second HAVING arm lets a
-- stale marker be cleared if an asset's duplicate ever goes away, which would otherwise
-- exclude the surviving sale from GMV permanently.
WITH d AS (
  SELECT site, account_id, asset_id
  FROM lqdt.sold_lots
  GROUP BY site, account_id, asset_id
  HAVING COUNT(*) > 1
     OR MAX(CASE WHEN superseded_by_auction IS NOT NULL THEN 1 ELSE 0 END) = 1
), r AS (
  SELECT s.row_key, s.superseded_by_auction AS cur,
         ROW_NUMBER() OVER (PARTITION BY s.site, s.account_id, s.asset_id
           ORDER BY s.close_time_utc DESC, TRY_CAST(s.auction_id AS bigint) DESC, s.auction_id DESC) AS rn,
         FIRST_VALUE(s.auction_id) OVER (PARTITION BY s.site, s.account_id, s.asset_id
           ORDER BY s.close_time_utc DESC, TRY_CAST(s.auction_id AS bigint) DESC, s.auction_id DESC) AS win
  FROM lqdt.sold_lots s
  JOIN d ON d.site = s.site AND d.account_id = s.account_id AND d.asset_id = s.asset_id
)
UPDATE t
   SET superseded_by_auction = CASE WHEN r.rn = 1 THEN NULL ELSE r.win END
  FROM lqdt.sold_lots t
  JOIN r ON r.row_key = t.row_key
 WHERE ISNULL(r.cur, '~') <> ISNULL(CASE WHEN r.rn = 1 THEN NULL ELSE r.win END, '~');
GO

-- KNOWN RESIDUAL (not fixed here). scripts/historical-gmv-daily-*.csv is the forecast's
-- source for historical days and is NOT deduped — it is built per-day, and a relisted
-- asset sells on two different days, so both land in the daily totals. Measured on
-- 2026-04-01..2026-06-29: CSV $239.62M vs store base $238.53M vs store deduped $236.34M.
-- So prior-year days (CSV) still carry ~1% of relist duplication while the live quarter
-- (store) no longer does, which slightly understates QTD Y/Y and slightly overstates the
-- auto capture rate. Fixing it means sourcing historical days from the deduped store
-- instead of the CSV — which would also retire the dual-source split that let a failed
-- store read collapse the live quarter to the sparse tracked feed.
