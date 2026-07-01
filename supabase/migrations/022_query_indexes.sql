-- Composite indexes matching the dashboard's actual query/order patterns.
-- future_improvements.md schema-hygiene note (index coverage).
--
-- Date columns remain `text` (ISO YYYY-MM-DD) intentionally: the app compares
-- and orders them as strings throughout, which is correct for zero-padded ISO
-- dates. Converting to date/timestamptz is a larger, separate migration and is
-- tracked as a follow-up in future_improvements.md.

-- page.tsx: marketplace_sellers ordered by (date desc, total_current_bid desc)
create index if not exists idx_marketplace_sellers_date_bid
  on marketplace_sellers (date desc, total_current_bid desc);

-- page.tsx: federal_contracts ordered by start_date desc
create index if not exists idx_federal_contracts_start
  on federal_contracts (start_date desc);

-- page.tsx: state_contracts ordered by (year desc, quarter desc)
create index if not exists idx_state_contracts_year_quarter
  on state_contracts (year desc, quarter desc);

-- computeRevenueForecast: auctions filtered by platform + status + close_time range
create index if not exists idx_auctions_platform_status_close
  on auctions (platform, status, close_time_utc);
