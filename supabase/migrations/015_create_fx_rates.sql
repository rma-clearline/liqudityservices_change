-- USD FX rate audit trail. The day's rates are persisted per cron run so any
-- stored USD amount (auction final_price_usd, current_bid_usd, GMV) can be
-- reproduced from its native amount + the rate that was actually applied.
-- future_improvements.md "Next" (reproducible/auditable historical GMV).
--
-- usd_per_unit follows the open.er-api.com base=USD convention: it is the
-- number of units of `currency` per 1 USD, so USD = native_amount / usd_per_unit.

create table if not exists fx_rates (
  id bigint generated always as identity primary key,
  date text not null,            -- ET date key (YYYY-MM-DD) the rate was fetched
  currency text not null,        -- ISO 4217 code
  usd_per_unit real not null,
  source text not null,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint fx_rates_date_currency_unique unique (date, currency)
);

alter table fx_rates enable row level security;
create policy "Public read access" on fx_rates for select using (true);

create index if not exists idx_fx_rates_currency_date on fx_rates (currency, date desc);
