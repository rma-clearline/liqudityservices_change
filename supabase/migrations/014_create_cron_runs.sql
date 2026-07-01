-- Per-source cron run log. One row per source per cron invocation (plus a
-- '__run__' summary row), so analysts and operators can see what data is fresh,
-- what failed, how long each source took, and how many rows landed.
-- future_improvements.md "Add a cron run log table".

create table if not exists cron_runs (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  source text not null,          -- listings | marketplace_metrics | auctions | federal_contracts | sam | state_contracts | email | __run__
  status text not null check (status in ('success', 'partial', 'failed', 'skipped')),
  rows_ingested integer,
  detail jsonb,                  -- source-specific counts / debug payload
  error text,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now()
);

alter table cron_runs enable row level security;
-- Reads via anon (dashboard freshness banner); writes via service role only.
create policy "Public read access" on cron_runs for select using (true);

create index if not exists idx_cron_runs_started on cron_runs (started_at desc);
create index if not exists idx_cron_runs_source_started on cron_runs (source, started_at desc);
