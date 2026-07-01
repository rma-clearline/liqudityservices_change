// Single source of truth for USD FX conversion + rate provenance.
//
// Previously fetchUsdRates/toUsd/CURRENCY_MAP were duplicated (and had drifted)
// across auctions.ts, marketplace-metrics.ts, historical-sales.ts, and the
// offline GMV script. This module unifies them and adds provenance: every
// conversion reports the rate it used and where the rate came from, and the
// day's rates are persisted to the `fx_rates` table so any stored USD figure
// is reproducible/auditable (future_improvements.md "Next").
//
// open.er-api.com returns USD-based rates where rates[XYZ] = units of XYZ per
// 1 USD, so USD = amount / rates[XYZ].

import { supabaseAdmin } from "./supabase";
import { etTodayKey } from "./time";

// Maestro currency codes → ISO codes. Superset of the per-file maps.
export const CURRENCY_MAP: Record<string, string> = {
  USD: "USD", ZAR: "ZAR", EUR: "EUR", GBP: "GBP", CAD: "CAD",
  AUD: "AUD", INR: "INR", BRL: "BRL", MXN: "MXN", JPY: "JPY", CNY: "CNY",
};

const FX_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const FX_CACHE_MS = 3_600_000; // 1h

export type FxRates = {
  /** rates[ISO] = units of that currency per 1 USD. */
  rates: Record<string, number>;
  fetchedAt: number;
  /** Provenance label recorded on each conversion. */
  source: string;
  /** ET date key the rates were fetched on. */
  date: string;
};

export type UsdConversion = {
  usd: number | null;
  /** The divisor applied (units per USD); null when no rate was available. */
  rateUsed: number | null;
  rateSource: string;
};

let cached: FxRates | null = null;

/** Fetch (and memoize for 1h) current USD rates. Never throws. */
export async function loadFxRates(): Promise<FxRates> {
  if (cached && Date.now() - cached.fetchedAt < FX_CACHE_MS) return cached;
  try {
    const res = await fetch(FX_SOURCE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return cached ?? emptyRates();
    const data = await res.json();
    const rates: Record<string, number> = data?.rates ?? {};
    cached = {
      rates,
      fetchedAt: Date.now(),
      source: FX_SOURCE_URL,
      date: etTodayKey(),
    };
    return cached;
  } catch {
    return cached ?? emptyRates();
  }
}

function emptyRates(): FxRates {
  return { rates: {}, fetchedAt: 0, source: "unavailable", date: etTodayKey() };
}

/**
 * Convert `amount` in `currencyCode` to USD, reporting the rate + source used.
 * Returns usd=null for a non-USD amount when no rate is available — callers
 * must NOT store a null-rate amount as USD (it would silently mislabel foreign
 * currency as dollars).
 */
export function convertToUsd(amount: number, currencyCode: string | null | undefined, fx: FxRates): UsdConversion {
  if (!currencyCode || currencyCode === "USD") {
    return { usd: amount, rateUsed: 1, rateSource: "USD" };
  }
  const code = CURRENCY_MAP[currencyCode] ?? currencyCode;
  const rate = fx.rates[code];
  if (rate && rate > 0) {
    return { usd: amount / rate, rateUsed: rate, rateSource: fx.source };
  }
  return { usd: null, rateUsed: null, rateSource: "unavailable" };
}

/** Round to cents, or null. */
export function roundUsd(usd: number | null): number | null {
  return usd === null ? null : Math.round(usd * 100) / 100;
}

/**
 * Best-effort: persist the day's rates for the tracked currencies to fx_rates
 * so historical conversions are reproducible. Never throws; a missing table or
 * RLS failure is swallowed (the app still runs without the audit trail).
 */
export async function persistFxRates(fx: FxRates): Promise<void> {
  if (fx.source === "unavailable" || Object.keys(fx.rates).length === 0) return;
  const fetchedAtIso = new Date(fx.fetchedAt || Date.now()).toISOString();
  const rows = Object.values(CURRENCY_MAP)
    .filter((code, i, arr) => arr.indexOf(code) === i && typeof fx.rates[code] === "number" && fx.rates[code] > 0)
    .map((code) => ({
      date: fx.date,
      currency: code,
      usd_per_unit: fx.rates[code],
      source: fx.source,
      fetched_at: fetchedAtIso,
    }));
  if (rows.length === 0) return;
  try {
    await supabaseAdmin.from("fx_rates").upsert(rows, { onConflict: "date,currency" });
  } catch {
    // fx_rates audit is best-effort; ingestion must not fail on it.
  }
}
