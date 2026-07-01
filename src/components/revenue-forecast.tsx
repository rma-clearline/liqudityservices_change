"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { downloadCsv, toCsv } from "@/lib/format";
import {
  ComposedChart,
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
  realized_revenue_usd: number;
  domestic_realized_revenue_usd: number;
  international_realized_revenue_usd: number;
  projected_revenue_usd: number;
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
  platforms: PlatformForecast[];
  daily: DailyPoint[];
  projected_total_gmv_usd: number;
  projected_total_revenue_usd: number;
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
            <p className="py-8 text-center text-sm text-gray-500">No sold auctions found for this day.</p>
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
                          {row.platform} / account {row.account_id} / asset {row.asset_id}
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

function realizedValueForMarket(point: DailyPoint, metric: ChartMetric, market: SalesMarketFilter) {
  if (metric === "revenue") {
    if (market === "domestic") return point.domestic_realized_revenue_usd;
    if (market === "international") return point.international_realized_revenue_usd;
    return point.realized_revenue_usd;
  }

  if (market === "domestic") return point.domestic_realized_gmv_usd;
  if (market === "international") return point.international_realized_gmv_usd;
  return point.realized_gmv_usd;
}

function DailyForecastChart({
  daily,
  metric,
  market,
  showStock,
  stockByDate,
  stockTicker,
  todayKey,
  onSelectDate,
}: {
  daily: DailyPoint[];
  metric: ChartMetric;
  market: SalesMarketFilter;
  showStock: boolean;
  stockByDate: Record<string, number>;
  stockTicker: string;
  todayKey: string;
  onSelectDate: (date: string) => void;
}) {
  const data = daily.map((d) => ({
    date: d.date,
    Realized: realizedValueForMarket(d, metric, market),
    Projected: market === "all" ? (metric === "gmv" ? d.projected_gmv_usd : d.projected_revenue_usd) : 0,
    Stock: showStock ? stockByDate[d.date] ?? null : null,
  }));
  const hasAny = data.some((d) => d.Realized > 0 || d.Projected > 0);
  const hasStock = showStock && data.some((d) => d.Stock != null);
  if (!hasAny) {
    return <p className="text-gray-500 text-sm py-8 text-center">No daily data yet - auctions table fills after the next cron run.</p>;
  }
  const todayLabel = todayKey;

  const handleChartAreaClick = (event: MouseEvent<HTMLDivElement>) => {
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
    <div className="cursor-pointer" onClick={handleChartAreaClick} aria-label="Open sales for selected daily GMV date">
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
          <ReferenceLine x={todayLabel} stroke="#9ca3af" strokeDasharray="4 2" label={{ value: "today", position: "top", fontSize: 10, fill: "#6b7280" }} />
          <Bar yAxisId="money" dataKey="Realized" stackId="a" fill="#2563eb" cursor="pointer" />
          {market === "all" && <Bar yAxisId="money" dataKey="Projected" stackId="a" fill="#93c5fd" cursor="pointer" />}
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

export function RevenueForecast() {
  const [takeRate, setTakeRate] = useState(0.2);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("gmv");
  const [chartMarket, setChartMarket] = useState<SalesMarketFilter>(DEFAULT_CHART_MARKET);
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
    let cancelled = false;
    fetch(`/api/forecast?takeRate=${takeRate}`)
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
  }, [takeRate]);

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
  const dailyStart = forecast.daily[0]?.date;
  const dailyEnd = forecast.daily[forecast.daily.length - 1]?.date;
  const dailyRange = dailyStart && dailyEnd ? `${dailyStart} to ${dailyEnd}` : forecast.quarter;
  const chartMarketLabel = chartMarket === "all" ? "" : `${CHART_MARKET_OPTIONS.find((option) => option.value === chartMarket)?.label ?? ""} `;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="text-sm text-gray-600">
          Quarter <span className="font-semibold text-gray-900">{forecast.quarter}</span>
        </div>
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
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card label={`Projected ${forecast.quarter} GMV`} value={fmtDollar(forecast.projected_total_gmv_usd)} />
        <Card label={`Projected ${forecast.quarter} Revenue`} value={fmtDollar(forecast.projected_total_revenue_usd)} strong />
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700">Daily {chartMarketLabel}{chartMetric === "gmv" ? "GMV" : "Revenue"} - {dailyRange}</h3>
          <div className="flex flex-wrap gap-2">
            <div className="flex gap-1">
              {CHART_MARKET_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setChartMarket(option.value)}
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
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                showStockPrice
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
          daily={forecast.daily}
          metric={chartMetric}
          market={chartMarket}
          showStock={showStockPrice && !stockError}
          stockByDate={stockByDate}
          stockTicker={stockState.ticker}
          todayKey={new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })}
          onSelectDate={setSelectedSalesDate}
        />
      </div>

      {ad && <PlatformBlock label="AllSurplus" color="text-blue-600" p={ad} />}
      {gd && <PlatformBlock label="GovDeals" color="text-green-600" p={gd} />}

      <p className="text-xs text-gray-400">
        Forecast = historical realized GMV where available + open-auction estimates using segment, category, then platform close rates and average hammer values.
        Revenue is estimated at the selected take rate.
      </p>

      {selectedSalesDate && (
        <SalesDetailsModal date={selectedSalesDate} market={chartMarket} onClose={() => setSelectedSalesDate(null)} />
      )}
    </div>
  );
}
