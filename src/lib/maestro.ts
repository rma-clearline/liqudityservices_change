// Single Maestro (Liquidity Services search backend) client.
//
// The URL/key constants, payload builders, response-shape handling, and
// timeout logic were duplicated across scraper.ts, marketplace-metrics.ts,
// auctions.ts, and historical-sales.ts. This module unifies them and adds
// retry/backoff + per-call timeouts (future_improvements.md "Data Quality").
//
// NOTE ON `businessId`: it is the *site* (AD = AllSurplus, GD = GovDeals), not
// the marketplace of an individual row. Each site surfaces cross-listed rows
// whose true marketplace is `row.businessId` (AD/GD/GI). Read row.businessId
// when the originating marketplace matters.

import { randomUUID } from "node:crypto";

export const MAESTRO_URL = process.env.MAESTRO_API_URL || "https://maestro.lqdt1.com";
export const MAESTRO_KEY =
  process.env.MAESTRO_API_KEY || "af93060f-337e-428c-87b8-c74b5837d6cd";

export const SEARCH_LIST_PATH = "/search/list";
export const SOLD_SEARCH_PATH = "/search/assets/advanced";

export type Platform = "AD" | "GD";

export function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** First non-empty string among `keys` on `raw`, trimmed; "" if none. */
export function safeString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

/** Open-listing search payload (POST /search/list). */
export function buildSearchPayload(
  businessId: Platform,
  page: number,
  displayRows: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    category: "",
    groupIds: [],
    businessId,
    searchText: "",
    isQAL: false,
    locationId: null,
    model: "",
    makebrand: "",
    accountIds: [],
    eventId: null,
    auctionTypeId: null,
    page,
    displayRows,
    sortField: "bestfit",
    sortOrder: "asc",
    requestType: "search",
    responseStyle: "",
    facets: [],
    facetsFilter: [],
    timeType: "atauction",
    sellerTypeId: null,
    ...overrides,
  };
}

/** Sold-archive search payload (POST /search/assets/advanced, rangeTimeSearchType="sold"). */
export function buildSoldPayload(
  businessId: Platform,
  fromDate: string,
  toDate: string,
  page: number,
  displayRows: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    businessId,
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
    page,
    displayRows,
    sortField: "currentBid",
    sortOrder: "desc",
    requestType: "search",
    responseStyle: "",
    facets: [],
    facetsFilter: [],
    timeType: "",
    sellerTypeId: null,
    rangeTimeSearchType: "sold",
    fromDate,
    toDate,
    ...overrides,
  };
}

export function extractListings(data: unknown): Record<string, unknown>[] {
  if (Array.isArray((data as { assetSearchResults?: unknown })?.assetSearchResults)) {
    return (data as { assetSearchResults: Record<string, unknown>[] }).assetSearchResults;
  }
  if (Array.isArray((data as { searchResults?: unknown })?.searchResults)) {
    return (data as { searchResults: Record<string, unknown>[] }).searchResults;
  }
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return [];
}

export type MaestroPage = {
  listings: Record<string, unknown>[];
  total: number | null;
  status: number | null;
  errorMessage: string | null;
  responseKeys: string | null;
};

export type MaestroFetchOptions = {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST a payload to a Maestro endpoint with a per-call timeout and exponential
 * backoff on transient failures (network error, timeout, 429, 5xx). 4xx (other
 * than 429) are returned immediately — retrying won't help.
 */
export async function maestroFetch(
  path: string,
  payload: unknown,
  { timeoutMs = 40_000, retries = 2, backoffMs = 500 }: MaestroFetchOptions = {},
): Promise<MaestroPage> {
  let last: MaestroPage = { listings: [], total: null, status: null, errorMessage: "not attempted", responseKeys: null };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${MAESTRO_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": MAESTRO_KEY,
          "x-user-id": "-1",
          "x-api-correlation-id": randomUUID(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store",
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        last = {
          listings: [],
          total: null,
          status: res.status,
          errorMessage: `http ${res.status}: ${body.slice(0, 200)}`,
          responseKeys: null,
        };
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        return last;
      }

      const data = await res.json();
      const headerCount = res.headers.get("x-total-count");
      const total = headerCount ? parseInt(headerCount, 10) || null : null;
      const responseKeys =
        data && !Array.isArray(data) ? Object.keys(data).slice(0, 10).join(",") : null;
      return { listings: extractListings(data), total, status: res.status, errorMessage: null, responseKeys };
    } catch (e) {
      last = {
        listings: [],
        total: null,
        status: null,
        errorMessage: `fetch error: ${e instanceof Error ? e.message : String(e)}`,
        responseKeys: null,
      };
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      return last;
    } finally {
      clearTimeout(timeout);
    }
  }

  return last;
}
