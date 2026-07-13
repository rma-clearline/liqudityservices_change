"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { downloadCsv, toCsv } from "@/lib/format";
import { etMonthKey, etQuarterKey, etWeekKey } from "@/lib/time";
import { siteLabel } from "@/lib/sites";
import { GmvExportModal } from "./gmv-export-modal";
import {
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

type DailyPoint = {
  date: string;
  realized_gmv_usd: number;
  domestic_realized_gmv_usd: number;
  international_realized_gmv_usd: number;
  projected_gmv_usd: number;
  ad_realized_gmv_usd: number;
  gd_realized_gmv_usd: number;
  gi_realized_gmv_usd: number;
  realized_revenue_usd: number;
  domestic_realized_revenue_usd: number;
  international_realized_revenue_usd: number;
  projected_revenue_usd: number;
  ad_realized_revenue_usd: number;
  gd_realized_revenue_usd: number;
  gi_realized_revenue_usd: number;
};

type PlatformForecast = {
  platform: "AD" | "GD";
  realized_gmv_usd: number;
  realized_revenue_usd: number;
  auctions_closed: number;
  auctions_sold: number;
  close_rate: number;
  avg_hammer_usd: number;
  realized_source: "historical_export" | "tracked_auctions";
  projection_model: string;
  scheduled_open_auctions: number;
  scheduled_open_bid_usd: number;
  projected_remaining_gmv_usd: number;
  projected_remaining_revenue_usd: number;
  projected_total_gmv_usd: number;
  projected_total_revenue_usd: number;
};

type Forecast = {
  quarter: string;
  quarter_start: string;
  quarter_end: string;
  take_rate: number;
  is_current: boolean;
  available_quarters: string[];
  platforms: PlatformForecast[];
  daily: DailyPoint[];
  projected_total_gmv_usd: number;
  projected_total_revenue_usd: number;
  realized_total_gmv_usd: number;
  realized_total_revenue_usd: number;
  earliest_data_date: string;
};

type StockPoint = {
  date: string;
  close: number;
};

type StockPriceResponse = {
  ticker: string;
  prices: StockPoint[];
  error?: string;
};

type StockState = {
  ticker: string;
  prices: StockPoint[];
  error: string | null;
  rangeKey: string | null;
};

type SaleRow = {
  platform: string;
  asset_id: string;
  auction_id: string;
  account_id: string;
  title: string;
  seller: string;
  category: string;
  country: string;
  state: string;
  close_time_utc: string;
  close_time_display: string;
  currency_code: string;
  sale_amount_native: number;
  sale_amount_usd: number | null;
  bid_count: number;
  url: string | null;
};

type SalesResponse = {
  date: string;
  page: number;
  page_size: number;
  total: number;
  unfiltered_total: number;
  facets: SalesFacets;
  rows: SaleRow[];
  error?: string;
};

type SalesFacets = {
  currencies: string[];
  countries: string[];
};

type SalesSortKey = "amount" | "name" | "seller" | "category" | "country" | "currency" | "bids" | "closed" | "platform";
type SalesSortOrder = "asc" | "desc";
type SalesMarketFilter = "all" | "domestic" | "international";

type SalesControls = {
  market: SalesMarketFilter;
  sortBy: SalesSortKey;
  sortOrder: SalesSortOrder;
  query: string;
  minAmount: string;
  maxAmount: string;
  currency: string;
  country: string;
};

type SalesState = {
  rows: SaleRow[];
  total: number;
  unfilteredTotal: number;
  facets: SalesFacets;
  page: number;
  loading: boolean;
  error: string | null;
};

const SALES_PAGE_SIZE = 250;
const EMPTY_SALES_FACETS: SalesFacets = { currencies: [], countries: [] };
function defaultSalesControls(market: SalesMarketFilter): SalesControls {
  return {
    market,
    sortBy: "amount",
    sortOrder: "desc",
    query: "",
    minAmount: "",
    maxAmount: "",
    currency: "",
    country: "",
  };
}

const SALES_MARKET_OPTIONS: { value: SalesMarketFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "domestic", label: "Domestic" },
  { value: "international", label: "International" },
];

const CHART_MARKET_OPTIONS = SALES_MARKET_OPTIONS;

const DEFAULT_CHART_MARKET: SalesMarketFilter = "all";
const STOCK_TICKER = "LQDT";

// Source = true marketplace. Selecting a specific source shows that source's
// realized GMV/revenue; it's mutually exclusive with the market split (the
// underlying data has per-source OR per-market totals, not the cross).
type SourceFilter = "all" | "AD" | "GD" | "GI";
const CHART_SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "AD", label: "AllSurplus" },
  { value: "GD", label: "GovDeals" },
  { value: "GI", label: "Industrial" },
];

const SALES_SORT_OPTIONS: { value: SalesSortKey; label: string }[] = [
  { value: "amount", label: "Amount" },
  { value: "name", label: "Name" },
  { value: "seller", label: "Seller" },
  { value: "category", label: "Category" },
  { value: "country", label: "Country" },
  { value: "currency", label: "Currency" },
  { value: "bids", label: "Bids" },
  { value: "closed", label: "Closed" },
  { value: "platform", label: "Platform" },
];

function fmtDollar(n: number | null | undefined) {
  if (n == null) return "-";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

function fmt(n: number | null | undefined) {
  return n != null ? n.toLocaleString("en-US") : "-";
}

function fmtPct(n: number | null | undefined) {
  return n != null ? (n * 100).toFixed(1) + "%" : "-";
}

function fmtMoney(n: number | null | undefined, currency = "USD") {
  if (n == null) return "-";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString("en-US")}`;
  }
}

function fmtCloseTime(row: SaleRow) {
  if (row.close_time_display) return row.close_time_display;
  if (!row.close_time_utc) return "-";
  return new Date(row.close_time_utc).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function fmtLocation(row: SaleRow) {
  return [row.state, row.country].filter(Boolean).join(", ") || "-";
}

function Card({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${strong ? "bg-gray-900 text-white border-gray-900" : ""}`}>
      <p className={`text-xs mb-1 ${strong ? "text-gray-300" : "text-gray-500"}`}>{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${strong ? "text-gray-400" : "text-gray-400"}`}>{sub}</p>}
    </div>
  );
}

function PlatformBlock({ label, color, p }: { label: string; color: string; p: PlatformForecast }) {
  const realizedSub =
    p.realized_source === "historical_export"
      ? `${fmt(p.auctions_sold)} sold lots from export`
      : `${fmt(p.auctions_sold)} sold / ${fmt(p.auctions_closed)} closed`;

  return (
    <div>
      <h3 className={`text-sm font-semibold mb-3 ${color}`}>{label}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="Realized GMV (QTD)" value={fmtDollar(p.realized_gmv_usd)} sub={realizedSub} />
        <Card label="Realized Revenue" value={fmtDollar(p.realized_revenue_usd)} sub={`at take rate`} />
        <Card label="Close Rate" value={fmtPct(p.close_rate)} sub={`avg hammer ${fmtDollar(p.avg_hammer_usd)}`} />
        <Card label="Scheduled Open" value={fmt(p.scheduled_open_auctions)} sub={`open bids ${fmtDollar(p.scheduled_open_bid_usd)}`} />
        <Card label="Projected Remaining GMV" value={fmtDollar(p.projected_remaining_gmv_usd)} />
        <Card label="Projected Remaining Rev" value={fmtDollar(p.projected_remaining_revenue_usd)} sub={p.projection_model} />
        <Card label="Projected Total GMV" value={fmtDollar(p.projected_total_gmv_usd)} />
        <Card label="Projected Total Revenue" value={fmtDollar(p.projected_total_revenue_usd)} strong />
      </div>
    </div>
  );
}

function SalesDetailsModal({
  date,
  market,
  onClose,
}: {
  date: string;
  market: SalesMarketFilter;
  onClose: () => void;
}) {
  const [controls, setControls] = useState<SalesControls>(() => defaultSalesControls(market));
  const [state, setState] = useState<SalesState>({
    rows: [],
    total: 0,
    unfilteredTotal: 0,
    facets: EMPTY_SALES_FACETS,
    page: 0,
    loading: true,
    error: null,
  });

  const salesRequestParams = useMemo(() => {
    const params = new URLSearchParams({
      date,
      pageSize: String(SALES_PAGE_SIZE),
      sortBy: controls.sortBy,
      sortOrder: controls.sortOrder,
      market: controls.market,
    });
    if (controls.query.trim()) params.set("query", controls.query.trim());
    if (controls.minAmount.trim()) params.set("minAmount", controls.minAmount.trim());
    if (controls.maxAmount.trim()) params.set("maxAmount", controls.maxAmount.trim());
    if (controls.currency) params.set("currency", controls.currency);
    if (controls.country) params.set("country", controls.country);
    return params;
  }, [controls, date]);

  const loadPage = useCallback(async (page: number, replace = false) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const params = new URLSearchParams(salesRequestParams);
      params.set("page", String(page));
      const res = await fetch(`/api/historical-sales?${params.toString()}`);
      const data = (await res.json()) as SalesResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState((prev) => ({
        rows: replace ? data.rows : [...prev.rows, ...data.rows],
        total: data.total,
        unfilteredTotal: data.unfiltered_total,
        facets: data.facets ?? prev.facets,
        page: data.page,
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [salesRequestParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadPage(1, true);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loadPage]);

  useEffect(() => {
    setControls(defaultSalesControls(market));
  }, [date, market]);

  const loaded = state.rows.length;
  const hasMore = loaded < state.total;
  const loadedGmv = state.rows.reduce((sum, row) => sum + (row.sale_amount_usd ?? 0), 0);
  const hasActiveFilters = Boolean(
    controls.market !== "all" ||
      controls.query.trim() ||
      controls.minAmount.trim() ||
      controls.maxAmount.trim() ||
      controls.currency ||
      controls.country,
  );

  function updateControl<Key extends keyof SalesControls>(key: Key, value: SalesControls[Key]) {
    setControls((prev) => ({ ...prev, [key]: value }));
  }

  function resetControls() {
    setControls(defaultSalesControls(market));
  }

  function exportCsv() {
    const csv = toCsv(state.rows, [
      { key: "platform", label: "Platform" },
      { key: "asset_id", label: "Asset ID" },
      { key: "auction_id", label: "Auction ID" },
      { key: "account_id", label: "Account ID" },
      { key: "title", label: "Title" },
      { key: "seller", label: "Seller" },
      { key: "category", label: "Category" },
      { key: "country", label: "Country" },
      { key: "state", label: "State" },
      { key: "close_time_utc", label: "Close (UTC)" },
      { key: "currency_code", label: "Currency" },
      { key: "sale_amount_native", label: "Native Amount" },
      { key: "sale_amount_usd", label: "USD Amount" },
      { key: "bid_count", label: "Bids" },
      { key: "url", label: "URL" },
    ]);
    downloadCsv(`lqdt-sales-${date}.csv`, csv);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sales-details-title"
        className="mx-auto flex max-h-[85vh] max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 id="sales-details-title" className="text-lg font-semibold text-gray-900">
              Sales on {date}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {fmt(loaded)} of {fmt(state.total)} loaded
              {hasActiveFilters && state.unfilteredTotal !== state.total ? ` from ${fmt(state.unfilteredTotal)} total` : ""}
              {loaded > 0 ? `, loaded GMV ${fmtDollar(loadedGmv)}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              disabled={loaded === 0}
              className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>

        <div className="border-b px-5 py-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-9">
            <label className="text-xs font-medium text-gray-600">
              Market
              <select
                value={controls.market}
                onChange={(event) => updateControl("market", event.target.value as SalesMarketFilter)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              >
                {SALES_MARKET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600 lg:col-span-2">
              Name
              <input
                type="search"
                value={controls.query}
                onChange={(event) => updateControl("query", event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
                placeholder="Asset or seller"
              />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Min Amount
              <input
                type="number"
                min="0"
                value={controls.minAmount}
                onChange={(event) => updateControl("minAmount", event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Max Amount
              <input
                type="number"
                min="0"
                value={controls.maxAmount}
                onChange={(event) => updateControl("maxAmount", event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Currency
              <select
                value={controls.currency}
                onChange={(event) => updateControl("currency", event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              >
                <option value="">All</option>
                {state.facets.currencies.map((currency) => (
                  <option key={currency} value={currency}>{currency}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Country
              <select
                value={controls.country}
                onChange={(event) => updateControl("country", event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              >
                <option value="">All</option>
                {state.facets.countries.map((country) => (
                  <option key={country} value={country}>{country}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Sort
              <select
                value={controls.sortBy}
                onChange={(event) => updateControl("sortBy", event.target.value as SalesSortKey)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              >
                {SALES_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-xs font-medium text-gray-600">
                Order
                <select
                  value={controls.sortOrder}
                  onChange={(event) => updateControl("sortOrder", event.target.value as SalesSortOrder)}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
                >
                  <option value="desc">Desc</option>
                  <option value="asc">Asc</option>
                </select>
              </label>
              <button
                type="button"
                onClick={resetControls}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {state.error && (
            <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.error}
            </div>
          )}

          {loaded === 0 && state.loading ? (
            <p className="py-8 text-center text-sm text-gray-500">Loading sales...</p>
          ) : loaded === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">
              {isBeforeArchiveWindow(date)
                ? "No lot-level detail for this date. Maestro's sold archive only retains roughly the last 12 months, so mid-2025 and earlier appear as aggregate GMV on the chart but have no per-lot rows to list or export."
                : "No sold auctions found for this day."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 bg-white text-xs uppercase text-gray-500">
                  <tr className="border-b">
                    <th className="py-2 pr-4 font-semibold">Sale</th>
                    <th className="py-2 pr-4 font-semibold">Asset</th>
                    <th className="py-2 pr-4 font-semibold">Seller</th>
                    <th className="py-2 pr-4 font-semibold">Category</th>
                    <th className="py-2 pr-4 font-semibold">Country</th>
                    <th className="py-2 pr-4 font-semibold">Bids</th>
                    <th className="py-2 pr-4 font-semibold">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row, index) => (
                    <tr key={`${row.platform}-${row.account_id}-${row.asset_id}-${row.auction_id}-${index}`} className="border-b align-top">
                      <td className="py-3 pr-4 font-semibold tabular-nums text-gray-900">
                        {fmtMoney(row.sale_amount_usd)}
                        {row.currency_code !== "USD" && (
                          <div className="mt-0.5 text-xs font-normal text-gray-500">
                            {fmtMoney(row.sale_amount_native, row.currency_code)}
                          </div>
                        )}
                      </td>
                      <td className="max-w-sm py-3 pr-4">
                        {row.url ? (
                          <a href={row.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">
                            {row.title || `Asset ${row.asset_id}`}
                          </a>
                        ) : (
                          <span className="font-medium text-gray-900">{row.title || `Asset ${row.asset_id}`}</span>
                        )}
                        <div className="mt-0.5 text-xs text-gray-500">
                          {siteLabel(row.platform)} / account {row.account_id} / asset {row.asset_id}
                        </div>
                      </td>
                      <td className="max-w-xs py-3 pr-4 text-gray-700">{row.seller || "-"}</td>
                      <td className="max-w-xs py-3 pr-4 text-gray-700">{row.category || "-"}</td>
                      <td className="py-3 pr-4 text-gray-700">{fmtLocation(row)}</td>
                      <td className="py-3 pr-4 tabular-nums text-gray-700">{fmt(row.bid_count)}</td>
                      <td className="py-3 pr-4 text-gray-700">{fmtCloseTime(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={state.loading}
                onClick={() => loadPage(state.page + 1)}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {state.loading ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type FetchState = { forecast: Forecast | null; error: string | null; done: boolean };

type ChartMetric = "gmv" | "revenue";

/**
 * True if `dateKey` is old enough to have likely aged out of Maestro's rolling
 * ~12-month sold archive. Such dates still have aggregate GMV on the chart (from
 * the historical export) but no per-lot rows to drill into or export.
 */
function isBeforeArchiveWindow(dateKey: string): boolean {
  const t = new Date(`${dateKey}T00:00:00Z`).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now() - 345 * 24 * 60 * 60 * 1000;
}

function realizedValue(point: DailyPoint, metric: ChartMetric, market: SalesMarketFilter, source: SourceFilter) {
  const revenue = metric === "revenue";
  if (source !== "all") {
    if (source === "AD") return revenue ? point.ad_realized_revenue_usd : point.ad_realized_gmv_usd;
    if (source === "GD") return revenue ? point.gd_realized_revenue_usd : point.gd_realized_gmv_usd;
    return revenue ? point.gi_realized_revenue_usd : point.gi_realized_gmv_usd; // GI
  }
  if (revenue) {
    if (market === "domestic") return point.domestic_realized_revenue_usd;
    if (market === "international") return point.international_realized_revenue_usd;
    return point.realized_revenue_usd;
  }
  if (market === "domestic") return point.domestic_realized_gmv_usd;
  if (market === "international") return point.international_realized_gmv_usd;
  return point.realized_gmv_usd;
}

type Granularity = "day" | "week" | "month";

const GRANULARITY_LABEL: Record<Granularity, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

/**
 * Re-bucket the daily forecast series into weekly (ISO week-start) or monthly
 * buckets by summing every GMV/revenue field. The API always returns daily
 * points, so this is a pure client-side view transform.
 */
function bucketDaily(daily: DailyPoint[], granularity: Granularity): DailyPoint[] {
  if (granularity === "day") return daily;
  const keyFn = granularity === "week" ? etWeekKey : etMonthKey;
  const map = new Map<string, DailyPoint>();
  for (const d of daily) {
    const key = keyFn(d.date);
    let agg = map.get(key);
    if (!agg) {
      agg = {
        date: key,
        realized_gmv_usd: 0,
        domestic_realized_gmv_usd: 0,
        international_realized_gmv_usd: 0,
        projected_gmv_usd: 0,
        ad_realized_gmv_usd: 0,
        gd_realized_gmv_usd: 0,
        gi_realized_gmv_usd: 0,
        realized_revenue_usd: 0,
        domestic_realized_revenue_usd: 0,
        international_realized_revenue_usd: 0,
        projected_revenue_usd: 0,
        ad_realized_revenue_usd: 0,
        gd_realized_revenue_usd: 0,
        gi_realized_revenue_usd: 0,
      };
      map.set(key, agg);
    }
    agg.realized_gmv_usd += d.realized_gmv_usd;
    agg.domestic_realized_gmv_usd += d.domestic_realized_gmv_usd;
    agg.international_realized_gmv_usd += d.international_realized_gmv_usd;
    agg.projected_gmv_usd += d.projected_gmv_usd;
    agg.ad_realized_gmv_usd += d.ad_realized_gmv_usd;
    agg.gd_realized_gmv_usd += d.gd_realized_gmv_usd;
    agg.gi_realized_gmv_usd += d.gi_realized_gmv_usd;
    agg.realized_revenue_usd += d.realized_revenue_usd;
    agg.domestic_realized_revenue_usd += d.domestic_realized_revenue_usd;
    agg.international_realized_revenue_usd += d.international_realized_revenue_usd;
    agg.projected_revenue_usd += d.projected_revenue_usd;
    agg.ad_realized_revenue_usd += d.ad_realized_revenue_usd;
    agg.gd_realized_revenue_usd += d.gd_realized_revenue_usd;
    agg.gi_realized_revenue_usd += d.gi_realized_revenue_usd;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function DailyForecastChart({
  daily,
  metric,
  market,
  source,
  granularity,
  showStock,
  stockByDate,
  stockTicker,
  todayKey,
  isCurrent,
  onSelectDate,
}: {
  daily: DailyPoint[];
  metric: ChartMetric;
  market: SalesMarketFilter;
  source: SourceFilter;
  granularity: Granularity;
  showStock: boolean;
  stockByDate: Record<string, number>;
  stockTicker: string;
  todayKey: string;
  isCurrent: boolean;
  onSelectDate: (date: string) => void;
}) {
  // Projected (future open auctions) only has meaning for the unfiltered total —
  // it isn't split by market or source — so show it only when both are "All".
  const showProjected = market === "all" && source === "all";
  const data = daily.map((d) => ({
    date: d.date,
    Realized: realizedValue(d, metric, market, source),
    Projected: showProjected ? (metric === "gmv" ? d.projected_gmv_usd : d.projected_revenue_usd) : 0,
    Stock: showStock ? stockByDate[d.date] ?? null : null,
  }));
  const hasAny = data.some((d) => d.Realized > 0 || d.Projected > 0);
  const hasStock = showStock && data.some((d) => d.Stock != null);
  if (!hasAny) {
    return <p className="text-gray-500 text-sm py-8 text-center">No daily data yet - auctions table fills after the next cron run.</p>;
  }
  const todayLabel = todayKey;

  const handleChartAreaClick = (event: MouseEvent<HTMLDivElement>) => {
    // Drill-down opens a single-day sales modal; only meaningful in day mode
    // (week/month bars carry a bucket key, not a single date).
    if (granularity !== "day") return;
    if (event.target instanceof Element && event.target.closest(".recharts-legend-wrapper")) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const plotLeftOffset = 80;
    const plotRightOffset = hasStock ? 72 : 16;
    const plotWidth = Math.max(1, bounds.width - plotLeftOffset - plotRightOffset);
    const clickX = event.clientX - bounds.left - plotLeftOffset;
    const ratio = Math.max(0, Math.min(1, clickX / plotWidth));
    const index = Math.round(ratio * (data.length - 1));

    onSelectDate(data[index].date);
  };

  return (
    <div
      className={granularity === "day" ? "cursor-pointer" : ""}
      onClick={handleChartAreaClick}
      aria-label="Open sales for selected daily GMV date"
    >
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={data} margin={{ top: 10, right: hasStock ? 22 : 16, bottom: 5, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} interval="preserveStartEnd" />
          <YAxis
            yAxisId="money"
            tickFormatter={(v: number) => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + "M" : (v / 1000).toFixed(0) + "k")}
            tick={{ fontSize: 11 }}
          />
          {hasStock && (
            <YAxis
              yAxisId="stock"
              orientation="right"
              width={50}
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
          )}
          <Tooltip
            formatter={(v, name) => {
              if (name === `${stockTicker} Close`) {
                return typeof v === "number" ? `$${v.toFixed(2)}` : v;
              }
              return typeof v === "number" ? "$" + v.toLocaleString() : v;
            }}
          />
          <Legend />
          {isCurrent && granularity === "day" && (
            <ReferenceLine x={todayLabel} stroke="#9ca3af" strokeDasharray="4 2" label={{ value: "today", position: "top", fontSize: 10, fill: "#6b7280" }} />
          )}
          <Bar yAxisId="money" dataKey="Realized" stackId="a" fill="#2563eb" cursor="pointer" />
          {showProjected && <Bar yAxisId="money" dataKey="Projected" stackId="a" fill="#93c5fd" cursor="pointer" />}
          {hasStock && (
            <Line
              yAxisId="stock"
              type="monotone"
              dataKey="Stock"
              name={`${stockTicker} Close`}
              stroke="#dc2626"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- Feature helpers/components -------------------------------------------

/** QTD realized (GMV + revenue) for the quarter containing `asOf`, through that day. */
function qtdRealizedAsOf(daily: DailyPoint[], asOf: string): { gmv: number; revenue: number; days: number } | null {
  if (!asOf) return null;
  const q = etQuarterKey(asOf);
  const inQ = daily.filter((d) => d.date <= asOf && etQuarterKey(d.date) === q);
  if (inQ.length === 0) return null;
  return {
    gmv: inQ.reduce((s, d) => s + d.realized_gmv_usd, 0),
    revenue: inQ.reduce((s, d) => s + d.realized_revenue_usd, 0),
    days: inQ.length,
  };
}

type PeriodRow = { period: string; gmv: number; revenue: number; seq: number | null; yoy: number | null; partial: boolean };

// Same formula works for month ("YYYY-MM") and quarter ("YYYYQn") keys.
const priorYearKey = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`;

function buildPeriodRows(daily: DailyPoint[], keyFn: (d: string) => string, currentKey: string): PeriodRow[] {
  const map = new Map<string, { gmv: number; revenue: number }>();
  for (const d of daily) {
    const k = keyFn(d.date);
    const b = map.get(k) ?? { gmv: 0, revenue: 0 };
    b.gmv += d.realized_gmv_usd;
    b.revenue += d.realized_revenue_usd;
    map.set(k, b);
  }
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  return keys.map((k, i) => {
    const cur = map.get(k)!;
    const prevSeq = i > 0 ? map.get(keys[i - 1]) : undefined;
    const prevYoy = map.get(priorYearKey(k));
    return {
      period: k,
      gmv: cur.gmv,
      revenue: cur.revenue,
      seq: prevSeq && prevSeq.gmv > 0 ? (cur.gmv - prevSeq.gmv) / prevSeq.gmv : null,
      yoy: prevYoy && prevYoy.gmv > 0 ? (cur.gmv - prevYoy.gmv) / prevYoy.gmv : null,
      partial: k === currentKey,
    };
  });
}

function GrowthPct({ v }: { v: number | null }) {
  if (v == null) return <span className="text-gray-300">—</span>;
  return (
    <span className={v >= 0 ? "text-green-600" : "text-red-600"}>
      {v >= 0 ? "+" : ""}
      {(v * 100).toFixed(1)}%
    </span>
  );
}

function PeriodTable({ title, seqLabel, rows }: { title: string; seqLabel: string; rows: PeriodRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <h4 className="mb-1 text-xs font-semibold uppercase text-gray-500">{title}</h4>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-gray-300 text-left">
            <th className="py-1 pr-4">Period</th>
            <th className="py-1 pr-4 text-right">GMV</th>
            <th className="py-1 pr-4 text-right">Revenue</th>
            <th className="py-1 pr-4 text-right">{seqLabel}</th>
            <th className="py-1 text-right">Y/Y</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period} className="border-b border-gray-100">
              <td className="py-1 pr-4 whitespace-nowrap">
                {r.period}
                {r.partial && <span className="ml-1 text-xs text-amber-600">(partial)</span>}
              </td>
              <td className="py-1 pr-4 text-right tabular-nums">{fmtDollar(r.gmv)}</td>
              <td className="py-1 pr-4 text-right tabular-nums text-gray-500">{fmtDollar(r.revenue)}</td>
              <td className="py-1 pr-4 text-right tabular-nums"><GrowthPct v={r.seq} /></td>
              <td className="py-1 text-right tabular-nums"><GrowthPct v={r.yoy} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Monthly + quarterly realized GMV with sequential (MoM/QoQ) and Y/Y growth. */
function GmvGrowthTable({ daily }: { daily: DailyPoint[] }) {
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const monthly = buildPeriodRows(daily, etMonthKey, etMonthKey(todayKey));
  const quarterly = buildPeriodRows(daily, etQuarterKey, etQuarterKey(todayKey));
  if (monthly.length === 0 && quarterly.length === 0) return null;
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Realized GMV/revenue by period (this view — select &ldquo;All (full history)&rdquo; for the complete series). Δ is sequential
        growth; Y/Y shows &ldquo;—&rdquo; until a prior-year period exists (~2 years of data).
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <PeriodTable title="Monthly" seqLabel="MoM" rows={monthly} />
        <PeriodTable title="Quarterly" seqLabel="QoQ" rows={quarterly} />
      </div>
    </div>
  );
}

// Categorical palette — validated with the dataviz skill's validate_palette.js
// (light surface, 10 slots: PASS; worst adjacent CVD ΔE 24.2). Assigned in FIXED
// order by GMV rank, never cycled: the chart shows at most CATEGORY_COLORS.length
// real categories and folds the rest into "Other". "Other" is the remainder, not an
// entity, so it takes a recessive gray — never a categorical hue.
const CATEGORY_COLORS = [
  "#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7",
  "#e34948", "#e87ba4", "#eb6834", "#0e8fa8", "#66a80f",
];
const OTHER_COLOR = "#898781";
// Cap options at the palette size (distinct, CVD-safe hues run out beyond ~10 —
// the long tail stays in "Other", inspectable via the hover tooltip).
const TOPN_OPTIONS = [6, 8, 10] as const;
const DEFAULT_TOPN = 8;

/** Fold a full period×category matrix down to the top-N categories by total GMV,
 *  bucketing the remainder into "Other". Mirrors the server's `categoryByPeriod`
 *  ranking (GMV desc → same color assignment). Done client-side so Top-N changes
 *  reuse the already-fetched series and never re-query the API/DB. */
function foldTopCategories(
  categories: string[],
  data: Array<Record<string, number | string>>,
  topN: number,
): { categories: string[]; data: Array<Record<string, number | string>> } {
  const real = categories.filter((c) => c !== "Other");
  const totals = new Map<string, number>(real.map((c) => [c, 0]));
  for (const row of data) for (const c of real) totals.set(c, (totals.get(c) ?? 0) + Number(row[c] ?? 0));
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]);
  const topSet = new Set(top);
  const outCats = [...top, "Other"];
  const outData = data.map((row) => {
    const out: Record<string, number | string> = { period: row.period };
    let other = Number(row["Other"] ?? 0);
    for (const c of real) {
      const v = Number(row[c] ?? 0);
      if (topSet.has(c)) out[c] = v;
      else other += v;
    }
    out["Other"] = other;
    return out;
  });
  return { categories: outCats, data: outData };
}

/** Stacked quarterly revenue (GMV × take rate) by category, from the durable store. */
function CategoryRevenueChart({ from, to, takeRate }: { from: string; to: string; takeRate: number }) {
  const [topN, setTopN] = useState<number>(DEFAULT_TOPN);
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    categories: string[];
    data: Array<Record<string, number | string>>;
    truncated: boolean;
  }>({ loading: true, error: null, categories: [], data: [], truncated: false });

  // Fetch the full composition once per range. Top-N is applied in memory below,
  // so toggling it never re-requests (hence no `topN` in the dependency list).
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(`/api/gmv-by-category?from=${from}&to=${to}&period=quarter`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => {
        if (!cancelled) {
          setState({ loading: false, error: null, categories: d.categories ?? [], data: d.data ?? [], truncated: Boolean(d.truncated) });
        }
      })
      .catch((e) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const folded = useMemo(
    () => foldTopCategories(state.categories, state.data, topN),
    [state.categories, state.data, topN],
  );

  const control = (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-xs text-gray-500">Top</span>
      <div className="flex gap-1">
        {TOPN_OPTIONS.map((n) => (
          <button
            key={n}
            onClick={() => setTopN(n)}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${
              topN === n
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <span className="text-xs text-gray-400">categories by GMV + Other</span>
    </div>
  );

  let body: ReactNode;
  if (state.loading) {
    body = <p className="py-8 text-center text-sm text-gray-500">Loading category breakdown…</p>;
  } else if (state.error) {
    body = <p className="py-4 text-sm text-red-600">Category breakdown unavailable: {state.error}</p>;
  } else if (folded.data.length === 0) {
    body = <p className="py-4 text-sm text-gray-500">No category data in range.</p>;
  } else {
    const data = folded.data.map((row) => {
      const out: Record<string, number | string> = { period: row.period };
      for (const c of folded.categories) out[c] = Math.round(Number(row[c] ?? 0) * takeRate);
      return out;
    });
    body = (
      <>
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={data} margin={{ top: 10, right: 16, bottom: 5, left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} />
            <YAxis
              tickFormatter={(v: number) => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + "M" : (v / 1000).toFixed(0) + "k")}
              tick={{ fontSize: 11 }}
            />
            <Tooltip formatter={(v) => (typeof v === "number" ? "$" + v.toLocaleString() : v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {folded.categories.map((c, i) => (
              // Fixed-order assignment (no cycling): rank i -> slot i; "Other" -> gray.
              <Bar key={c} dataKey={c} stackId="cat" fill={c === "Other" ? OTHER_COLOR : (CATEGORY_COLORS[i] ?? OTHER_COLOR)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-1 text-xs text-gray-400">
          Revenue = category GMV × {(takeRate * 100).toFixed(0)}% take rate. Top {topN} categories by GMV; the rest grouped as
          Other (hover any segment for its exact category and value).
          {state.truncated ? " Value-ranked sample (top lots by value) — captures most GMV, not every tail lot." : ""}
        </p>
      </>
    );
  }

  return (
    <div>
      {control}
      {body}
    </div>
  );
}

export function RevenueForecast() {
  const [takeRate, setTakeRate] = useState(0.2);
  const [requestedTakeRate, setRequestedTakeRate] = useState(0.2);
  const [quarter, setQuarter] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("gmv");
  const [chartMarket, setChartMarket] = useState<SalesMarketFilter>(DEFAULT_CHART_MARKET);
  const [chartSource, setChartSource] = useState<SourceFilter>("all");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [showExport, setShowExport] = useState(false);
  const [qtdDate, setQtdDate] = useState("");
  const [showCategory, setShowCategory] = useState(false);
  const [showStockPrice, setShowStockPrice] = useState(false);
  const [stockState, setStockState] = useState<StockState>({
    ticker: STOCK_TICKER,
    prices: [],
    error: null,
    rangeKey: null,
  });
  const [selectedSalesDate, setSelectedSalesDate] = useState<string | null>(null);
  const [state, setState] = useState<FetchState>({ forecast: null, error: null, done: false });

  useEffect(() => {
    const timer = window.setTimeout(() => setRequestedTakeRate(takeRate), 300);
    return () => window.clearTimeout(timer);
  }, [takeRate]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ takeRate: String(requestedTakeRate) });
    if (quarter) params.set("quarter", quarter);
    fetch(`/api/forecast?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setState({ forecast: data, error: null, done: true });
      })
      .catch((e) => {
        if (!cancelled) setState((prev) => ({ forecast: prev.forecast, error: e instanceof Error ? e.message : String(e), done: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [requestedTakeRate, quarter]);

  const stockDateRange = useMemo(() => {
    const daily = state.forecast?.daily ?? [];
    return {
      from: daily[0]?.date ?? "",
      to: daily[daily.length - 1]?.date ?? "",
    };
  }, [state.forecast]);

  useEffect(() => {
    if (!showStockPrice || !stockDateRange.from || !stockDateRange.to) return;

    let cancelled = false;
    const rangeKey = `${stockDateRange.from}:${stockDateRange.to}`;
    const params = new URLSearchParams({
      ticker: STOCK_TICKER,
      from: stockDateRange.from,
      to: stockDateRange.to,
    });

    fetch(`/api/stock-prices?${params.toString()}`)
      .then(async (response) => {
        const data = (await response.json()) as StockPriceResponse;
        if (!response.ok) {
          throw new Error(data.error || `Stock price request failed (${response.status})`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setStockState({
          ticker: data.ticker || STOCK_TICKER,
          prices: data.prices ?? [],
          error: null,
          rangeKey,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setStockState((prev) => ({
          ...prev,
          error: e instanceof Error ? e.message : String(e),
          rangeKey,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [showStockPrice, stockDateRange.from, stockDateRange.to]);

  const stockRangeKey = stockDateRange.from && stockDateRange.to ? `${stockDateRange.from}:${stockDateRange.to}` : null;
  const stockError = stockState.rangeKey === stockRangeKey ? stockState.error : null;
  const stockLoading = showStockPrice && Boolean(stockRangeKey) && stockState.rangeKey !== stockRangeKey;

  const stockByDate = useMemo(() => {
    const byDate: Record<string, number> = {};
    for (const price of stockState.prices) {
      byDate[price.date] = price.close;
    }
    return byDate;
  }, [stockState.prices]);

  const { forecast, error, done } = state;
  if (!done && !forecast) return <p className="text-gray-500 text-sm">Loading forecast...</p>;
  if (error && !forecast) return <p className="text-red-600 text-sm">Error: {error}</p>;
  if (!forecast) return <p className="text-gray-500 text-sm">No forecast data yet. Auctions table fills after the next cron run.</p>;

  const ad = forecast.platforms.find((p) => p.platform === "AD");
  const gd = forecast.platforms.find((p) => p.platform === "GD");
  const isAll = forecast.quarter === "ALL";
  const totalGmvLabel = isAll
    ? "Total GMV (all data)"
    : `${forecast.is_current ? "Projected" : "Realized"} ${forecast.quarter} GMV`;
  const totalRevLabel = isAll
    ? "Total Revenue (all data)"
    : `${forecast.is_current ? "Projected" : "Realized"} ${forecast.quarter} Revenue`;
  const dailyStart = forecast.daily[0]?.date;
  const dailyEnd = forecast.daily[forecast.daily.length - 1]?.date;
  const dailyRange = dailyStart && dailyEnd ? `${dailyStart} to ${dailyEnd}` : forecast.quarter;
  const chartMarketLabel = chartMarket === "all" ? "" : `${CHART_MARKET_OPTIONS.find((option) => option.value === chartMarket)?.label ?? ""} `;
  const chartSliceLabel =
    chartSource !== "all"
      ? `${CHART_SOURCE_OPTIONS.find((o) => o.value === chartSource)?.label ?? ""} `
      : chartMarketLabel;
  // Cheap derived values (≤ ~458 rows); computed inline since this is past the
  // component's early returns where hooks can't be called.
  const chartDaily = bucketDaily(forecast.daily, granularity);
  const qtd = qtdRealizedAsOf(forecast.daily, qtdDate);
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // Export/QTD date bounds: the actual GMV data range (earliest data day →
  // today), so users can't query dates with no data. Default the export to the
  // full history; analysts narrow it in the modal.
  const earliestDataDate = forecast.earliest_data_date || dailyStart || todayKey;
  const exportFrom = earliestDataDate;
  const exportTo = todayKey;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <label className="text-sm text-gray-600 flex items-center gap-2">
          Quarter
          <select
            value={forecast.quarter}
            onChange={(e) => setQuarter(e.target.value)}
            className="border rounded px-2 py-0.5 text-sm text-gray-900"
          >
            <option value="ALL">All (full history)</option>
            {[...forecast.available_quarters].reverse().map((q, i) => (
              <option key={q} value={q}>
                {q}{i === 0 ? " (current)" : ""}
              </option>
            ))}
          </select>
          {forecast.quarter === "ALL" ? (
            <span className="text-xs text-gray-400">full daily history + current-quarter projection</span>
          ) : (
            !forecast.is_current && <span className="text-xs text-gray-400">closed quarter — realized only</span>
          )}
        </label>
        <label className="text-sm text-gray-600 flex items-center gap-2">
          Take rate
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={takeRate}
            onChange={(e) => setTakeRate(Math.max(0, Math.min(1, Number(e.target.value) || 0)))}
            className="w-20 border rounded px-2 py-0.5 text-sm"
          />
          <span className="text-xs text-gray-400">{(takeRate * 100).toFixed(0)}%</span>
        </label>
        <button
          onClick={() => setShowExport(true)}
          className="ml-auto rounded border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Export GMV data
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card label={totalGmvLabel} value={fmtDollar(isAll ? forecast.realized_total_gmv_usd : forecast.projected_total_gmv_usd)} />
        <Card label={totalRevLabel} value={fmtDollar(isAll ? forecast.realized_total_revenue_usd : forecast.projected_total_revenue_usd)} strong />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-gray-50 p-3 text-sm">
        <label className="flex items-center gap-2 text-gray-600">
          QTD as of
          <input
            type="date"
            value={qtdDate}
            min={earliestDataDate}
            max={todayKey}
            onChange={(e) => {
              const v = e.target.value;
              // Clamp to the data range so users can't pick dates with no data.
              setQtdDate(!v ? "" : v < earliestDataDate ? earliestDataDate : v > todayKey ? todayKey : v);
            }}
            className="rounded border px-2 py-0.5 text-sm text-gray-900"
          />
        </label>
        {qtd ? (
          <span className="text-gray-700">
            <strong>{etQuarterKey(qtdDate)}</strong> realized through {qtdDate}:{" "}
            <strong className="text-gray-900">{fmtDollar(qtd.revenue)}</strong> revenue ·{" "}
            {fmtDollar(qtd.gmv)} GMV <span className="text-gray-400">({qtd.days} days in)</span>
          </span>
        ) : qtdDate ? (
          <span className="text-xs text-gray-400">
            No realized data for that date in this view — switch the Quarter selector to &ldquo;All (full history)&rdquo;.
          </span>
        ) : (
          <span className="text-xs text-gray-400">
            Pick a date to see quarter-to-date realized revenue as of that day (compare the QTD pace vs full-quarter guidance).
          </span>
        )}
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700">{GRANULARITY_LABEL[granularity]} {chartSliceLabel}{chartMetric === "gmv" ? "GMV" : "Revenue"} - {dailyRange}</h3>
          <div className="flex flex-wrap gap-2">
            <div className="flex gap-1">
              {(["day", "week", "month"] as Granularity[]).map((g) => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    granularity === g
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
                  }`}
                >
                  {g === "day" ? "Day" : g === "week" ? "Week" : "Month"}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {CHART_MARKET_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  // Market and source are mutually exclusive (no source×market data).
                  onClick={() => {
                    setChartMarket(option.value);
                    if (option.value !== "all") setChartSource("all");
                  }}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    chartMarket === option.value
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {CHART_SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    setChartSource(option.value);
                    if (option.value !== "all") setChartMarket("all");
                  }}
                  title="Filter by source (marketplace)"
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    chartSource === option.value
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {(["gmv", "revenue"] as ChartMetric[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setChartMetric(m)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    chartMetric === m
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
                  }`}
                >
                  {m === "gmv" ? "GMV" : "Revenue"}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowStockPrice((current) => !current)}
              aria-pressed={showStockPrice}
              disabled={granularity !== "day"}
              title={granularity !== "day" ? "LQDT price overlay is available in Day view" : undefined}
              className={`px-2 py-0.5 text-xs rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                showStockPrice && granularity === "day"
                  ? "bg-red-600 text-white border-red-600"
                  : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
              }`}
            >
              {stockLoading ? "LQDT..." : "LQDT Price"}
            </button>
          </div>
        </div>
        {showStockPrice && stockError && (
          <p className="mb-2 text-xs text-red-600">LQDT price unavailable.</p>
        )}
        <DailyForecastChart
          daily={chartDaily}
          metric={chartMetric}
          market={chartMarket}
          source={chartSource}
          granularity={granularity}
          showStock={showStockPrice && !stockError && granularity === "day"}
          stockByDate={stockByDate}
          stockTicker={stockState.ticker}
          todayKey={todayKey}
          isCurrent={forecast.is_current}
          onSelectDate={setSelectedSalesDate}
        />
      </div>

      <GmvGrowthTable daily={forecast.daily} />

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700">Quarterly revenue by category</h3>
          <button
            onClick={() => setShowCategory((v) => !v)}
            className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            {showCategory ? "Hide" : "Show category breakdown"}
          </button>
        </div>
        {showCategory && <CategoryRevenueChart from={exportFrom} to={exportTo} takeRate={takeRate} />}
      </div>

      {!isAll && ad && <PlatformBlock label="AllSurplus" color="text-blue-600" p={ad} />}
      {!isAll && gd && <PlatformBlock label="GovDeals" color="text-green-600" p={gd} />}
      {isAll && (
        <p className="text-sm text-gray-500">
          Per-platform breakdown (close rate, avg hammer, projection) is shown per quarter — select a quarter above.
        </p>
      )}

      <p className="text-xs text-gray-400">
        Forecast = historical realized GMV where available + open-auction estimates using segment, category, then platform close rates and average hammer values.
        Revenue is estimated at the selected take rate.
      </p>

      {selectedSalesDate && (
        <SalesDetailsModal date={selectedSalesDate} market={chartMarket} onClose={() => setSelectedSalesDate(null)} />
      )}

      {showExport && (
        <GmvExportModal
          defaultFrom={exportFrom}
          defaultTo={exportTo}
          minDate={earliestDataDate}
          maxDate={todayKey}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
