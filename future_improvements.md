# future_improvements

## Applying the new migrations

This change adds migrations **013–015 and 017–022** (016 is intentionally unused).
They are additive and safe to apply in filename order via the Supabase SQL editor. Until they are applied, the app degrades
gracefully (new columns/tables read as null/empty; ingestion of new columns will
error and be logged in `cron_runs` once that table exists). New optional env var:
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (least-privilege reader; falls back to the secret
key if unset).

## Done in this change

- **Shared libraries** (`src/lib/maestro.ts`, `fx.ts`, `time.ts`, `http.ts`) —
  removed the duplicated Maestro client / FX / ET-date / fetch logic that had
  drifted across five files. Maestro + HTTP calls now have retry/backoff + timeouts.
- **Sale-date FX provenance** — `fx_rates` table (015) + per-row `sale_amount_native`,
  `fx_rate_used`, `fx_source` on `auctions` (013). USD figures are now reproducible.
- **Richer auction data** (013) — title, geography (country/state/city), make/model/
  year, `reserve_status`, `event_id`, `auction_type_id`, `keywords`, `url`,
  `lot_number`, and `row_business_id` (true marketplace) captured at ingest.
- **Marketplace coverage + reserve** (017) — `pages_fetched`, `is_full_coverage`,
  `listings_with_reserve`, `reserve_rate`; the fake hardcoded `avg_watch_count` now
  writes null (no such field exists in Maestro) and the UI shows reserve rate.
- **Seller movers** (019) — `marketplace_seller_deltas` view + dashboard widget for
  new/disappeared sellers and biggest listing/GMV movers.
- **Cron run log** (014) — `cron_runs` table + per-source status/rows/errors/duration
  written each run; `GET /api/data-status` powers dashboard freshness + alerting.
- **UX** — top-of-page reconciliation summary, per-section freshness badges, an
  alerts banner (failed runs / stale data / 0-row pulls), sticky section nav, CSV
  export on the sales modal + seller/contract/opportunity tables, and a title/scope
  rename.
- **Security** — writes moved to a server-only service-role client (`supabaseAdmin`);
  anon key is read-only; dropped the over-permissive anon write policies (018);
  rate + size limits on the manual snapshot endpoint.
- **Breadth** — USAspending pagination + humanized award types; SAM set-aside +
  place-of-performance enrichment + broader NAICS; state/local `record_type` (021),
  Socrata `$offset` pagination, stronger vendor normalization; wired the previously
  orphaned Riverside adapter.
- **Query indexes** (022) for the dashboard's order/filter patterns.

## Discovered correctness issues (documented; not fully fixed here)

- **Auction platform mislabel + double-count.** Maestro `businessId` is the *site*
  (AD/GD); each site returns cross-listed rows whose true marketplace is
  `row.businessId` (AD/GD/GI). `ingestPlatform`/`ingestSoldPlatform` label `platform`
  by the query site, so per-platform realized GMV is mislabeled, and a cross-listed
  asset returned by both the AD- and GD-site sold runs is upserted under two
  `platform` values → **double-counted realized GMV**. Migration 013 adds the truthful
  `row_business_id` column; the dedup/attribution fix belongs with the forecasting
  workstream (change the sold ingest to dedup by asset across sites and attribute by
  `row_business_id`).

## Remaining / deferred

### Forecasting rigor (deferred by request)
- Persist `forecast_snapshots` (per-run per-platform totals, model label, take rate)
  for QoQ explainability; add confidence intervals from historical residuals; a
  `scripts/backtest-forecast.mjs` harness reporting error by platform/category/price
  band/bid band/days-to-close (reuse `buildProjectionModel`/`segmentKey`).
- Seasonality features (quarter-end, weekday/weekend, holidays, known events).
- Per-platform take rate (AD vs GD) instead of a single flat rate.
- Fix the platform double-count (above) so realized GMV is attributed correctly.

### Data quality & operations
- Split the cron into per-source endpoints with independent Vercel schedules
  (`/api/cron` already isolates + logs + retries each source; this is the deployment
  step: add `?only=<source>` gating + separate `vercel.json` crons so a slow source
  can't consume the shared 60s budget).
- Active alerting (email/webhook) on failed runs / large day-over-day GMV swings, on
  top of the dashboard alerts banner now in place.
- Validate the historical CSV (schema, date coverage, duplicates, GMV totals) before
  use in forecasts.
- Convert `text` date columns to `date`/`timestamptz` (kept as ISO text for now since
  code compares them as strings; needs a coordinated code + data migration).

### Contracts & opportunities
- USAspending **ceiling value** (base-and-all-options): not exposed by
  `spending_by_award`; requires the award-detail endpoint per award.
- SAM.gov attachments + full opportunity-detail fetch (current enrichment reads
  set-aside/place-of-performance from the search response without an extra call).
- Persist source-query metadata (pages fetched, windows) beyond the `cron_runs` detail.

### Marketplace
- Background full-crawl mode for seller/category metrics when API limits allow.
- Watch/view counts are unavailable from the Maestro search feed (confirmed via live
  probing); revisit if a listing-detail endpoint exposes them.
