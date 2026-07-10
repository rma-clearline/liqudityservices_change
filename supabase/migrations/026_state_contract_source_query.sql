-- Preserve the one raw field needed for source links, then remove bulky source
-- payloads that the UI never displays.
alter table state_contracts add column if not exists source_query text;

update state_contracts
set source_query = coalesce(
  case source_dataset_id
    when 'n8q6-4twj' then coalesce(raw_data->>'contract_number', contract_id)
    when 's4vu-giwb' then coalesce(raw_data->>'voucher_number', contract_id)
    when 'rsxa-ify5' then coalesce(raw_data->>'purchase_order_contract_number', raw_data->>'specification_number', contract_id)
    when 'cyqb-8ina' then raw_data->>'payment_id'
    when 'qrj9-83t8' then coalesce(raw_data->>'trans_id', raw_data->>'check_no')
    when '8c6z-qnmj' then raw_data->>'rfed_doc_id'
    when 'vpf9-6irq' then coalesce(raw_data->>'invoice_id', raw_data->>'po_num')
    when 'swwh-4ka9' then raw_data->>'invoice_id'
    when '6e9e-sfc4' then raw_data->>'document_number'
    when '8izy-bwhd' then raw_data->>'document_number'
    else vendor_name
  end,
  contract_id,
  vendor_name
)
where source_query is null;

update state_contracts set raw_data = null where raw_data is not null;
