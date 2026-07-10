-- Bound operational history and the duplicate closed-auction cache. The durable
-- per-lot archive remains in Azure SQL; Supabase only needs enough closed rows
-- to calibrate the current-quarter forecast.

create or replace function run_cost_retention()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cron_deleted integer := 0;
  sellers_deleted integer := 0;
  auctions_deleted integer := 0;
begin
  delete from cron_runs where started_at < now() - interval '90 days';
  get diagnostics cron_deleted = row_count;

  delete from marketplace_sellers
  where date < to_char(current_date - interval '548 days', 'YYYY-MM-DD');
  get diagnostics sellers_deleted = row_count;

  delete from auctions
  where status <> 'open'
    and close_time_utc < now() - interval '120 days';
  get diagnostics auctions_deleted = row_count;

  return jsonb_build_object(
    'cron_runs', cron_deleted,
    'marketplace_sellers', sellers_deleted,
    'auctions', auctions_deleted
  );
end;
$$;

revoke all on function run_cost_retention() from public, anon, authenticated;
grant execute on function run_cost_retention() to service_role;
