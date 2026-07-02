-- State/local contracts: distinguish "first seen" from "last seen".
--
-- The cron used to upsert with ignoreDuplicates, which froze existing rows at
-- their original values — so refreshed quarterly sales/amounts were never
-- written and the section looked "not updated in months". We now MERGE on
-- conflict (update matched rows), which means:
--   * `last_seen_date` advances every run the row is still present  -> freshness
--   * `first_seen_date` must stay at the original insert date       -> provenance
--
-- A plain upsert would overwrite first_seen_date too, so a BEFORE UPDATE trigger
-- pins it back to the previous value. Freshness (/api/data-status) reads
-- last_seen_date for this table.

alter table state_contracts add column if not exists last_seen_date text;

-- Backfill: existing rows were last confirmed when first seen.
update state_contracts set last_seen_date = first_seen_date where last_seen_date is null;

create index if not exists idx_state_contracts_last_seen on state_contracts (last_seen_date desc);

-- first_seen_date is insert-only: preserve the prior value on every update.
create or replace function state_contracts_preserve_first_seen()
returns trigger as $$
begin
  new.first_seen_date := old.first_seen_date;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_state_contracts_preserve_first_seen on state_contracts;
create trigger trg_state_contracts_preserve_first_seen
  before update on state_contracts
  for each row execute function state_contracts_preserve_first_seen();
