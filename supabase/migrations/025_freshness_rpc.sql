-- One PostgREST call replaces seven separate freshness requests. Each MAX uses
-- the existing date/freshness indexes.
create or replace function latest_data_freshness()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'listings', (select max(date) from listings),
    'marketplace_sellers', (select max(date) from marketplace_sellers),
    'auctions', (select max(last_seen_at)::text from auctions),
    'federal_contracts', (select max(first_seen_date) from federal_contracts),
    'contract_snapshots', (select max(date) from contract_snapshots),
    'sam_opportunities', (select max(first_seen_date) from sam_opportunities),
    'state_contracts', coalesce(
      (select max(ended_at)::text from cron_runs where source = 'state_contracts' and status in ('success', 'partial')),
      (select max(coalesce(last_seen_date, first_seen_date)) from state_contracts)
    )
  );
$$;

grant execute on function latest_data_freshness() to anon, authenticated, service_role;
