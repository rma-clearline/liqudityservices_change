-- Current-quarter forecast materialized by the daily reconciliation. This keeps
-- interactive dashboard reads off Azure SQL while preserving a live fallback.
create table if not exists forecast_snapshots (
  quarter text primary key,
  payload jsonb not null,
  generated_at timestamptz not null default now()
);

alter table forecast_snapshots enable row level security;

drop policy if exists "Public read access" on forecast_snapshots;
create policy "Public read access" on forecast_snapshots for select using (true);

create index if not exists idx_forecast_snapshots_generated
  on forecast_snapshots (generated_at desc);
