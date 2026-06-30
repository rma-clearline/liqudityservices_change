#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAESTRO_URL = "https://maestro.lqdt1.com";
const DEFAULT_MAESTRO_KEY = "af93060f-337e-428c-87b8-c74b5837d6cd";
const DEFAULT_PAGE_SIZE = 10000;
const DEFAULT_OUT = "scripts/historical-gmv.csv";

function parseArgs(argv) {
  const args = {
    from: null,
    to: null,
    out: DEFAULT_OUT,
    bucket: "month",
    siteBusiness: "AD",
    pageSize: DEFAULT_PAGE_SIZE,
    noFx: false,
    marketSplit: false,
    dailyRequests: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error("Missing value for " + arg);
      return argv[i];
    };

    if (arg === "--from") args.from = next();
    else if (arg === "--to") args.to = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--bucket") args.bucket = next();
    else if (arg === "--site-business") args.siteBusiness = next();
    else if (arg === "--page-size") args.pageSize = Number(next());
    else if (arg === "--no-fx") args.noFx = true;
    else if (arg === "--market-split") args.marketSplit = true;
    else if (arg === "--daily-requests") args.dailyRequests = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  if (!args.from || !args.to) throw new Error("Both --from and --to are required.");
  if (!["day", "month", "quarter", "year"].includes(args.bucket)) {
    throw new Error("--bucket must be one of: day, month, quarter, year.");
  }
  if (!Number.isFinite(args.pageSize) || args.pageSize <= 0) {
    throw new Error("--page-size must be a positive number.");
  }

  return args;
}

function printHelp() {
  console.log([
    "Fetch historical sold-auction GMV from the Maestro advanced search API.",
    "",
    "Usage:",
    "  node scripts/fetch-historical-gmv.mjs --from 2025-06-01 --to 2026-06-29",
    "",
    "Options:",
    "  --from YYYY-MM-DD          Start date, inclusive",
    "  --to YYYY-MM-DD            End date, inclusive",
    "  --out PATH                 CSV output path (default: " + DEFAULT_OUT + ")",
    "  --bucket day|month|quarter|year",
    "                             Aggregation bucket (default: month)",
    "  --site-business CODE       Maestro site business to query (default: AD)",
    "  --page-size N              Rows per API page (default: " + DEFAULT_PAGE_SIZE + ")",
    "  --no-fx                    Do not fetch current FX rates; only USD rows count toward USD GMV",
    "  --market-split             Aggregate ALL, DOMESTIC, and INTERNATIONAL rows by sale country",
    "  --daily-requests           Fetch each ET calendar day separately to avoid broad-search caps",
    "  --quiet                    Suppress per-page progress logs",
    "",
    "Notes:",
    "  The discovered historical endpoint is POST /search/assets/advanced with",
    "  rangeTimeSearchType=\"sold\". The AD site query surfaces the broadest historical",
    "  archive seen in probing, including AD, GD, and GI row-level business IDs.",
  ].join("\n"));
}

function toApiStart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value + "T00:00:00.000Z";
  return new Date(value).toISOString();
}

function toApiEnd(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value + "T23:59:59.999Z";
  return new Date(value).toISOString();
}

function formatPartsInEt(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function localEtToUtcMs(date, hour, minute, second, millisecond) {
  const [year, month, day] = date.split("-").map(Number);
  const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let utcMs = targetLocalMs + 5 * 60 * 60 * 1000;

  for (let i = 0; i < 3; i += 1) {
    const parts = formatPartsInEt(new Date(utcMs));
    const renderedLocalMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    utcMs += targetLocalMs - renderedLocalMs;
  }

  return utcMs;
}

function nextDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return d.toISOString().slice(0, 10);
}

function dateRangeForEtDay(date) {
  const startMs = localEtToUtcMs(date, 0, 0, 0, 0);
  const endMs = localEtToUtcMs(nextDate(date), 0, 0, 0, 0) - 1;
  return {
    fromIso: new Date(startMs).toISOString(),
    toIso: new Date(endMs).toISOString(),
  };
}

function enumerateDates(from, to) {
  const dates = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = nextDate(cursor);
  }
  return dates;
}

function safeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function etParts(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

function bucketKey(iso, bucket) {
  const parts = etParts(iso);
  if (bucket === "day") return parts.year + "-" + parts.month + "-" + parts.day;
  if (bucket === "month") return parts.year + "-" + parts.month;
  if (bucket === "quarter") {
    const quarter = Math.floor((Number(parts.month) - 1) / 3) + 1;
    return parts.year + "Q" + quarter;
  }
  return parts.year;
}

async function fetchUsdRates(skipFx) {
  if (skipFx) return {};
  const res = await fetch("https://open.er-api.com/v6/latest/USD", {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("FX rate fetch failed with HTTP " + res.status);
  const data = await res.json();
  return data.rates || {};
}

function toUsd(amount, currencyCode, rates) {
  if (!currencyCode || currencyCode === "USD") return amount;
  const rate = rates[currencyCode];
  if (rate && rate > 0) return amount / rate;
  return null;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function countryForRow(row) {
  return safeString(row.country || row.countryCode || row.assetCountry || row.locationCountry).toUpperCase();
}

function marketForRow(row) {
  const country = countryForRow(row);
  if (!country) return "UNKNOWN";
  if (
    country === "USA" ||
    country === "US" ||
    country === "UNITED STATES" ||
    country === "UNITED STATES OF AMERICA"
  ) {
    return "DOMESTIC";
  }
  return "INTERNATIONAL";
}

function rowKey(row, includeBusiness) {
  const closeIso = typeof row.assetAuctionEndDateUtc === "string" ? row.assetAuctionEndDateUtc : "";
  return [
    includeBusiness && typeof row.businessId === "string" ? row.businessId : "",
    row.accountId || "",
    row.assetId || "",
    row.auctionId || "",
    closeIso,
  ].join(":");
}

function buildPayload({ siteBusiness, fromIso, toIso, page, pageSize }) {
  return {
    businessId: siteBusiness,
    category: "",
    subCategory: "",
    groupIds: [],
    searchText: "",
    isQAL: false,
    locationId: null,
    model: "",
    makebrand: "",
    accountIds: [],
    agencies: [],
    eventId: null,
    auctionTypeId: null,
    page: page,
    displayRows: pageSize,
    sortField: "currentBid",
    sortOrder: "desc",
    requestType: "search",
    responseStyle: "",
    facets: [],
    facetsFilter: [],
    timeType: "",
    sellerTypeId: null,
    rangeTimeSearchType: "sold",
    fromDate: fromIso,
    toDate: toIso,
  };
}

async function fetchSoldPage({ baseUrl, apiKey, siteBusiness, fromIso, toIso, page, pageSize }) {
  const res = await fetch(baseUrl + "/search/assets/advanced", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "x-user-id": "-1",
      "x-api-correlation-id": crypto.randomUUID(),
    },
    body: JSON.stringify(buildPayload({ siteBusiness, fromIso, toIso, page, pageSize })),
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Maestro returned non-JSON HTTP " + res.status + ": " + text.slice(0, 200));
  }

  if (!res.ok) {
    throw new Error("Maestro HTTP " + res.status + ": " + text.slice(0, 300));
  }

  const rows = Array.isArray(data.assetSearchResults)
    ? data.assetSearchResults
    : Array.isArray(data.searchResults)
      ? data.searchResults
      : Array.isArray(data)
        ? data
        : [];

  return {
    total: Number(res.headers.get("x-total-count") || rows.length),
    rows: rows,
  };
}

function addToAggregate({ bucketName, businessId, market, amount, currency, usd, buckets }) {
  const aggregateKey = [bucketName, businessId, market].filter(Boolean).join("|");
  let aggregate = buckets.get(aggregateKey);
  if (!aggregate) {
    aggregate = {
      bucket: bucketName,
      business_id: businessId,
      market: market || "",
      sold_lots: 0,
      gmv_usd_current_fx: 0,
      skipped_fx_lots: 0,
      native: new Map(),
    };
    buckets.set(aggregateKey, aggregate);
  }

  aggregate.sold_lots += 1;
  aggregate.native.set(currency, (aggregate.native.get(currency) || 0) + amount);

  if (usd === null) aggregate.skipped_fx_lots += 1;
  else aggregate.gmv_usd_current_fx += usd;
}

function aggregateRow({ row, rates, bucket, buckets, platformSeen, allSeen }) {
  const closeIso = typeof row.assetAuctionEndDateUtc === "string" ? row.assetAuctionEndDateUtc : null;
  const amount = safeNumber(row.currentBid);
  const currency = typeof row.currencyCode === "string" && row.currencyCode ? row.currencyCode : "USD";
  const rowBusiness = typeof row.businessId === "string" && row.businessId ? row.businessId : "UNKNOWN";

  if (!closeIso || amount === null) return;

  const bucketName = bucketKey(closeIso, bucket);
  const usd = toUsd(amount, currency, rates);
  const platformKey = rowKey(row, true);
  if (rowBusiness !== "ALL" && !platformSeen.has(platformKey)) {
    platformSeen.add(platformKey);
    addToAggregate({ bucketName, businessId: rowBusiness, market: "", amount, currency, usd, buckets });
  }

  const allKey = rowKey(row, false);
  if (!allSeen.has(allKey)) {
    allSeen.add(allKey);
    addToAggregate({ bucketName, businessId: "ALL", market: "", amount, currency, usd, buckets });
  }
}

function aggregateMarketRow({ row, rates, bucket, buckets, allSeen }) {
  const closeIso = typeof row.assetAuctionEndDateUtc === "string" ? row.assetAuctionEndDateUtc : null;
  const amount = safeNumber(row.currentBid);
  const currency = typeof row.currencyCode === "string" && row.currencyCode ? row.currencyCode : "USD";
  const key = rowKey(row, false);

  if (!closeIso || amount === null || allSeen.has(key)) return;
  allSeen.add(key);

  const bucketName = bucketKey(closeIso, bucket);
  const usd = toUsd(amount, currency, rates);
  addToAggregate({ bucketName, businessId: "ALL", market: "ALL", amount, currency, usd, buckets });
  addToAggregate({ bucketName, businessId: "ALL", market: marketForRow(row), amount, currency, usd, buckets });
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return "\"" + text.replaceAll("\"", "\"\"") + "\"";
  return text;
}

function toCsv(buckets, marketSplit) {
  const rows = Array.from(buckets.values()).sort((a, b) => {
    const byBucket = a.bucket.localeCompare(b.bucket);
    const byBusiness = byBucket || a.business_id.localeCompare(b.business_id);
    return byBusiness || a.market.localeCompare(b.market);
  });

  const header = marketSplit
    ? ["date", "business_id", "market", "sold_lots", "gmv_usd_current_fx", "skipped_fx_lots", "gmv_native_by_currency"]
    : [rows.some((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.bucket)) ? "date" : "bucket", "business_id", "sold_lots", "gmv_usd_current_fx", "skipped_fx_lots", "gmv_native_by_currency"];
  const lines = [header.join(",")];

  for (const row of rows) {
    const native = Object.fromEntries(
      Array.from(row.native.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amount]) => [currency, Math.round(amount * 100) / 100]),
    );

    const values = marketSplit
      ? [
          row.bucket,
          row.business_id,
          row.market,
          row.sold_lots,
          Math.round(row.gmv_usd_current_fx * 100) / 100,
          row.skipped_fx_lots,
          JSON.stringify(native),
        ]
      : [
          row.bucket,
          row.business_id,
          row.sold_lots,
          Math.round(row.gmv_usd_current_fx * 100) / 100,
          row.skipped_fx_lots,
          JSON.stringify(native),
        ];

    lines.push(values.map(csvEscape).join(","));
  }

  return lines.join("\n") + "\n";
}

async function fetchRangeIntoBuckets({
  baseUrl,
  apiKey,
  siteBusiness,
  fromIso,
  toIso,
  pageSize,
  label,
  rates,
  bucket,
  buckets,
  marketSplit,
  platformSeen,
  allSeen,
  quiet,
  filterDate,
}) {
  let page = 1;
  let total = null;
  let fetchedRows = 0;

  while (true) {
    const result = await fetchSoldPage({
      baseUrl,
      apiKey,
      siteBusiness,
      fromIso,
      toIso,
      page,
      pageSize,
    });

    if (total === null) {
      total = result.total;
      if (!quiet) console.log(label + " Maestro sold archive count: " + total);
    }

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      if (filterDate) {
        const closeIso = typeof row.assetAuctionEndDateUtc === "string" ? row.assetAuctionEndDateUtc : "";
        if (!closeIso || bucketKey(closeIso, "day") !== filterDate) continue;
      }
      if (marketSplit) aggregateMarketRow({ row, rates, bucket, buckets, allSeen });
      else aggregateRow({ row, rates, bucket, buckets, platformSeen, allSeen });
    }

    fetchedRows += result.rows.length;
    if (!quiet) console.log(label + " fetched page " + page + ": " + fetchedRows + "/" + total);

    if (total !== null && fetchedRows >= total) break;
    if (result.rows.length < pageSize && total === null) break;
    page += 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.MAESTRO_API_URL || DEFAULT_MAESTRO_URL;
  const apiKey = process.env.MAESTRO_API_KEY || DEFAULT_MAESTRO_KEY;
  const rates = await fetchUsdRates(args.noFx);
  const buckets = new Map();
  const platformSeen = new Set();
  const allSeen = new Set();

  if (args.dailyRequests) {
    for (const date of enumerateDates(args.from, args.to)) {
      const { fromIso, toIso } = dateRangeForEtDay(date);
      await fetchRangeIntoBuckets({
        baseUrl,
        apiKey,
        siteBusiness: args.siteBusiness,
        fromIso,
        toIso,
        pageSize: args.pageSize,
        label: date,
        rates,
        bucket: args.bucket,
        buckets,
        marketSplit: args.marketSplit,
        platformSeen,
        allSeen,
        quiet: args.quiet,
        filterDate: date,
      });
    }
  } else {
    await fetchRangeIntoBuckets({
      baseUrl,
      apiKey,
      siteBusiness: args.siteBusiness,
      fromIso: toApiStart(args.from),
      toIso: toApiEnd(args.to),
      pageSize: args.pageSize,
      label: "Range",
      rates,
      bucket: args.bucket,
      buckets,
      marketSplit: args.marketSplit,
      platformSeen,
      allSeen,
      quiet: args.quiet,
    });
  }

  const outPath = path.resolve(args.out);
  await writeFile(outPath, toCsv(buckets, args.marketSplit), "utf8");
  console.log("Wrote " + buckets.size + " aggregate rows to " + outPath);
  console.log("Unique sold lots aggregated: " + allSeen.size);
  if (!args.noFx) console.log("Non-USD GMV uses current USD FX rates from open.er-api.com.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
