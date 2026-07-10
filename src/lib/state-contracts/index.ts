import type { RecordType, StateAdapter, StateContract } from "./types";
import { washingtonAdapter } from "./washington";
import { marylandAdapter } from "./maryland";
import { chicagoAdapter } from "./chicago";
import { iowaAdapter } from "./iowa";
import { newJerseyAdapter } from "./newjersey";
import { cincinnatiAdapter } from "./cincinnati";
import { austinAdapter } from "./austin";
import { montgomeryMdAdapter } from "./montgomeryMd";
import { oregonAdapter } from "./oregon";
import { riversideAdapter } from "./riverside";

export const STATE_ADAPTERS: StateAdapter[] = [
  washingtonAdapter,
  marylandAdapter,
  chicagoAdapter,
  iowaAdapter,
  newJerseyAdapter,
  cincinnatiAdapter,
  austinAdapter,
  montgomeryMdAdapter,
  oregonAdapter,
  riversideAdapter,
];

// Per-dataset record-type classification so awards/contracts aren't blended
// with payment/spending rows. Datasets not listed default to "payment"
// (checkbook/spending exports, which are the majority).
const DATASET_RECORD_TYPES: Record<string, RecordType> = {
  "n8q6-4twj": "contract", // WA master-contract sales report
  "rsxa-ify5": "contract", // Chicago contracts
};

function recordTypeFor(datasetId: string): RecordType {
  return DATASET_RECORD_TYPES[datasetId] ?? "payment";
}

function sourceQueryFor(row: StateContract): string {
  const raw = row.raw_data;
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = raw[key];
      if (value != null && String(value).trim()) return String(value);
    }
    return "";
  };
  switch (row.source_dataset_id) {
    case "n8q6-4twj": return first("contract_number") || row.contract_id;
    case "s4vu-giwb": return first("voucher_number") || row.contract_id;
    case "rsxa-ify5": return first("purchase_order_contract_number", "specification_number") || row.contract_id;
    case "cyqb-8ina": return first("payment_id");
    case "qrj9-83t8": return first("trans_id", "check_no");
    case "8c6z-qnmj": return first("rfed_doc_id");
    case "vpf9-6irq": return first("invoice_id", "po_num");
    case "swwh-4ka9": return first("invoice_id");
    case "6e9e-sfc4":
    case "8izy-bwhd": return first("document_number");
    default: return row.vendor_name;
  }
}

export async function fetchAllStateContracts(): Promise<{
  contracts: StateContract[];
  perState: Record<string, { count: number; error: string | null }>;
}> {
  const perState: Record<string, { count: number; error: string | null }> = {};
  const contracts: StateContract[] = [];

  const results = await Promise.all(
    STATE_ADAPTERS.map(async (adapter) => {
      try {
        const rows = await adapter.fetch();
        return { adapter, rows, error: null as string | null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { adapter, rows: [] as StateContract[], error: msg };
      }
    }),
  );

  for (const { adapter, rows, error } of results) {
    perState[adapter.stateCode] = { count: rows.length, error };
    for (const row of rows) {
      row.record_type = row.record_type ?? recordTypeFor(row.source_dataset_id);
      row.source_query = sourceQueryFor(row);
      contracts.push(row);
    }
  }

  return { contracts, perState };
}

export type { StateContract, StateAdapter } from "./types";
