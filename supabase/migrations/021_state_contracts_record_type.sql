-- Classify state/local rows by lifecycle stage so awards/contracts aren't
-- blended with payment/spending records. future_improvements.md "Separate
-- state/local contract records by record type and source semantics".

alter table state_contracts add column if not exists record_type text not null default 'payment';

-- Rebuild the uniqueness key to include record_type, so the same contract_id
-- can legitimately appear as different lifecycle stages without colliding.
alter table state_contracts drop constraint if exists state_contracts_uniq;
alter table state_contracts
  add constraint state_contracts_uniq
  unique (state_code, source_dataset_id, contract_id, vendor_normalized, year, quarter, customer_agency, record_type);

create index if not exists idx_state_contracts_record_type on state_contracts (record_type);
