-- Enrich auction rows with fields the Maestro feed already returns but the
-- ingester was dropping. Gives analysts item-level detail (title, geography,
-- make/model, reserve status, event/auction-type) and — critically — FX
-- provenance so every USD figure is reproducible from native amount + rate.
-- future_improvements.md "Enrich auction rows..." and "Next".
--
-- NOTE: `platform` is the query *site* (AD/GD). `row_business_id` is the row's
-- true originating marketplace (AD/GD/GI). A follow-up (deferred forecasting
-- workstream) will use row_business_id to fix per-platform mislabeling and the
-- cross-listed double-count; this migration just captures the truth column.

alter table auctions add column if not exists title text;
alter table auctions add column if not exists country text;
alter table auctions add column if not exists state text;
alter table auctions add column if not exists city text;
alter table auctions add column if not exists make text;
alter table auctions add column if not exists model text;
alter table auctions add column if not exists model_year text;
alter table auctions add column if not exists lot_number text;
alter table auctions add column if not exists keywords text;
alter table auctions add column if not exists url text;
alter table auctions add column if not exists event_id text;
alter table auctions add column if not exists auction_type_id text;
alter table auctions add column if not exists row_business_id text;
alter table auctions add column if not exists reserve_status text;   -- none | set | not_met | reduced | met
alter table auctions add column if not exists is_new_asset boolean;
alter table auctions add column if not exists sale_amount_native numeric;
alter table auctions add column if not exists fx_rate_used real;     -- units of currency per 1 USD
alter table auctions add column if not exists fx_source text;
alter table auctions add column if not exists watch_count integer;   -- reserved; Maestro exposes no watch/view field today

create index if not exists auctions_row_business_id on auctions (row_business_id);
create index if not exists auctions_reserve_status on auctions (reserve_status);
