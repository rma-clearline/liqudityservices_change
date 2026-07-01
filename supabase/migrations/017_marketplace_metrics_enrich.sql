-- Marketplace metrics enrichment:
--  * coverage metadata (was this a full census or a sample?) — previously only
--    encoded in the free-text debug string.
--  * reserve metrics — Maestro exposes hasReservePrice per listing but no
--    watch/view count, so avg_watch_count is now written NULL and reserve
--    coverage replaces it as the "richer" signal.
-- future_improvements.md "Store metrics coverage metadata".

alter table marketplace_metrics add column if not exists listings_with_reserve integer;
alter table marketplace_metrics add column if not exists reserve_rate real;
alter table marketplace_metrics add column if not exists pages_fetched integer;
alter table marketplace_metrics add column if not exists is_full_coverage boolean;
