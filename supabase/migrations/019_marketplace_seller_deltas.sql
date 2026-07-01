-- Seller change-over-time: compares each platform's two most recent snapshots
-- so the dashboard can surface new sellers, disappeared sellers, and the
-- biggest listing-count / GMV-proxy movers.
-- future_improvements.md "Track seller-level changes over time".
--
-- security_invoker so the querying role's RLS (public read on
-- marketplace_sellers) applies to the view.

create or replace view marketplace_seller_deltas
with (security_invoker = on) as
with ranked_dates as (
  select platform, date,
         row_number() over (partition by platform order by date desc) as rn
  from (select distinct platform, date from marketplace_sellers) d
),
latest as (select platform, date from ranked_dates where rn = 1),
previous as (select platform, date from ranked_dates where rn = 2),
cur as (
  select s.platform, s.account_id, s.company_name, s.country, s.state,
         s.listing_count, s.total_current_bid, s.total_bids, s.date
  from marketplace_sellers s
  join latest l on s.platform = l.platform and s.date = l.date
),
pr as (
  select s.platform, s.account_id,
         s.listing_count as prev_listing_count,
         s.total_current_bid as prev_total_current_bid,
         s.date as prev_date
  from marketplace_sellers s
  join previous p on s.platform = p.platform and s.date = p.date
)
select
  coalesce(cur.platform, pr.platform) as platform,
  coalesce(cur.account_id, pr.account_id) as account_id,
  cur.company_name,
  cur.country,
  cur.state,
  cur.date as snapshot_date,
  pr.prev_date,
  cur.listing_count,
  pr.prev_listing_count,
  coalesce(cur.listing_count, 0) - coalesce(pr.prev_listing_count, 0) as listing_count_delta,
  cur.total_current_bid,
  pr.prev_total_current_bid,
  coalesce(cur.total_current_bid, 0) - coalesce(pr.prev_total_current_bid, 0) as gmv_delta,
  (pr.account_id is null) as is_new,
  (cur.account_id is null) as disappeared
from cur
full outer join pr on cur.platform = pr.platform and cur.account_id = pr.account_id;
