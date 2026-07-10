-- Insert new state-contract records and update only rows whose business fields
-- changed. Successful source freshness comes from cron_runs, so confirming an
-- unchanged row no longer creates a PostgreSQL row version/WAL record.
create or replace function upsert_state_contracts_cost_aware(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  insert into state_contracts (
    state_code, source_portal, source_dataset_id, contract_id, vendor_name,
    vendor_normalized, customer_agency, contract_title, amount, year, quarter,
    period_start, period_end, record_type, source_query, first_seen_date, last_seen_date
  )
  select
    x.state_code, x.source_portal, x.source_dataset_id, x.contract_id, x.vendor_name,
    x.vendor_normalized, x.customer_agency, x.contract_title, x.amount, x.year, x.quarter,
    x.period_start, x.period_end, coalesce(x.record_type, 'payment'), x.source_query,
    x.first_seen_date, x.last_seen_date
  from jsonb_to_recordset(p_rows) as x(
    state_code text, source_portal text, source_dataset_id text, contract_id text,
    vendor_name text, vendor_normalized text, customer_agency text, contract_title text,
    amount numeric, year text, quarter text, period_start date, period_end date,
    record_type text, source_query text, first_seen_date text, last_seen_date text
  )
  on conflict on constraint state_contracts_uniq do update set
    source_portal = excluded.source_portal,
    vendor_name = excluded.vendor_name,
    contract_title = excluded.contract_title,
    amount = excluded.amount,
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    source_query = excluded.source_query,
    last_seen_date = excluded.last_seen_date
  where row(
    state_contracts.source_portal, state_contracts.vendor_name,
    state_contracts.contract_title, state_contracts.amount,
    state_contracts.period_start, state_contracts.period_end, state_contracts.source_query
  ) is distinct from row(
    excluded.source_portal, excluded.vendor_name,
    excluded.contract_title, excluded.amount,
    excluded.period_start, excluded.period_end, excluded.source_query
  );

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function upsert_state_contracts_cost_aware(jsonb) from public, anon, authenticated;
grant execute on function upsert_state_contracts_cost_aware(jsonb) to service_role;
