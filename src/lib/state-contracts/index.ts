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
      contracts.push(row);
    }
  }

  return { contracts, perState };
}

export type { StateContract, StateAdapter } from "./types";
