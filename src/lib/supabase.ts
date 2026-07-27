import { createClient } from "@supabase/supabase-js";

export type ListingRow = {
  id: number;
  date: string;
  timestamp: string;
  allsurplus: number;
  govdeals: number;
  created_at: string;
};

export type MarketplaceSellerRow = {
  id: number;
  date: string;
  platform: "AD" | "GD";
  account_id: string;
  company_name: string;
  country: string | null;
  state: string | null;
  listing_count: number | null;
  total_current_bid: number | null;
  total_bids: number | null;
  top_bid_asset_id: string | null;
  sub_business_id: string | null;
  created_at: string;
};

export type SellerDeltaRow = {
  platform: "AD" | "GD";
  account_id: string;
  company_name: string | null;
  country: string | null;
  state: string | null;
  snapshot_date: string | null;
  prev_date: string | null;
  listing_count: number | null;
  prev_listing_count: number | null;
  listing_count_delta: number | null;
  total_current_bid: number | null;
  prev_total_current_bid: number | null;
  gmv_delta: number | null;
  is_new: boolean | null;
  disappeared: boolean | null;
};

export type AuctionRow = {
  id: number;
  platform: "AD" | "GD";
  asset_id: string;
  seller_account_id: string | null;
  seller_company: string | null;
  category: string | null;
  currency_code: string | null;
  current_bid_usd: number | null;
  bid_count: number | null;
  close_time_utc: string | null;
  status: "open" | "closed_sold" | "closed_nosale" | "unknown";
  final_price_usd: number | null;
  // Enrichment (migration 013)
  title: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  make: string | null;
  model: string | null;
  model_year: string | null;
  lot_number: string | null;
  keywords: string | null;
  url: string | null;
  event_id: string | null;
  auction_type_id: string | null;
  row_business_id: string | null;
  reserve_status: string | null;
  is_new_asset: boolean | null;
  sale_amount_native: number | null;
  fx_rate_used: number | null;
  fx_source: string | null;
  watch_count: number | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  created_at: string;
};

export type AuctionDailyStatsRow = {
  close_date: string;
  platform: "AD" | "GD";
  auctions_closed: number;
  auctions_sold: number;
  auctions_scheduled_open: number;
  auctions_total: number;
  realized_gmv_usd: number;
  avg_hammer_usd: number;
  scheduled_open_bid_usd: number;
  total_bids_closed: number;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
// Optional least-privilege anon/publishable key for reads. When set, browser
// and server reads go through RLS ("public read") instead of the secret key.
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const clientOptions = { auth: { persistSession: false } } as const;

/**
 * Read client. Prefers the least-privilege anon key; falls back to the secret
 * key so existing deployments keep working until `NEXT_PUBLIC_SUPABASE_ANON_KEY`
 * is configured. Use this for all SELECTs (server components, read API routes).
 */
export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY || SUPABASE_SECRET_KEY,
  clientOptions,
);

/**
 * Server-only writer (service role, bypasses RLS). Use for all inserts/updates
 * (cron ingestion, fx-rate audit, cron-run logging). Never import into a client
 * component — it carries the secret key.
 */
export const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  clientOptions,
);
