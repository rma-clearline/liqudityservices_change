import "server-only";

// Which store backs the app's relational table data during the Supabase→Azure
// migration (docs/azure-migration-spec.md). Defaults to "supabase"; flip to
// "azure" per-environment via DATA_BACKEND once the Azure access layer is wired
// and data is copied. This is the single, reversible cutover lever — set it back
// to "supabase" to roll back instantly. The durable sold-lot store (lqdt.sold_lots)
// is unaffected: it is always Azure regardless of this flag.
export type DataBackend = "supabase" | "azure";

export function dataBackend(): DataBackend {
  return (process.env.DATA_BACKEND ?? "supabase").trim().toLowerCase() === "azure" ? "azure" : "supabase";
}

/** True when relational reads/writes should go to Azure SQL instead of Supabase. */
export function useAzureData(): boolean {
  return dataBackend() === "azure";
}
