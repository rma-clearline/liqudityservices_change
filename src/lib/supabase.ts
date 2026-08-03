// Shared database row-shape types. Formerly the Supabase client module; the app
// now runs entirely on Azure SQL (see src/lib/azure-tables.ts), so only these
// types remain. (Filename kept to avoid churning the many type imports.)

export type ListingRow = {
  id: number;
  date: string;
  timestamp: string;
  allsurplus: number;
  govdeals: number;
  created_at: string;
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

