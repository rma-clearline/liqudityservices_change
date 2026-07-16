# Durable sold-lot store (Azure SQL `lqdt.sold_lots`)

The dashboard's per-lot sold data lives in a rolling ~12-month Maestro archive that
**rolls off** — so anything older than ~today−365d is lost forever. This store
captures that data durably and makes the forecast/export/drill-down read complete,
deduped, GI-inclusive data instead of the lossy Supabase `auctions` table.

## Where it lives
- Server: `cl-sql-db-svr.database.windows.net` (Azure SQL, resource group `cl-tool-rg`, East US 2)
- Database: `cl-sql-db` · Schema: `lqdt` (owned by the least-privilege app user `lqdt_app`)
- Tables: `lqdt.sold_lots` (+ `lqdt.sold_lots_staging` heap for bulk-load → MERGE)
- Engine is **Azure SQL / T-SQL**, client is [`mssql`](https://www.npmjs.com/package/mssql).

## Identity / dedup
Rows are keyed on `row_key = site:account_id:asset_id:auction_id` — the export's
`fetchSoldRange` dedup key **exactly**. `asset_id`+`auction_id` alone is NOT unique
(GovDeals reuses small asset numbers across seller accounts), so keying on those
would merge distinct lots. Writes are idempotent (MERGE on `row_key`) and
concurrency-safe (per-call `batch_id` in the staging heap, deadlock-retried).

## Env (server-only — never `NEXT_PUBLIC`)
```
AZURE_SQL_SERVER   = cl-sql-db-svr.database.windows.net
AZURE_SQL_DATABASE = cl-sql-db
AZURE_SQL_USER     = lqdt_app
AZURE_SQL_PASSWORD = <lqdt_app password>
```
If unset, everything transparently falls back to the live Maestro feed.

## Data flow
- **Backfill (one-time):** `GET /api/backfill-sold?from=YYYY-MM-DD&to=YYYY-MM-DD&key=$CRON_SECRET`
  (drive it month-by-month; idempotent, re-runnable; `maxPages` bounds the page budget).
- **Daily capture:** the four-hour cron only runs the `sold_lots` reconciliation
  during `DAILY_INGEST_HOURS_ET` (default `11,12`, DST-safe). It writes the last
  `SOLD_CAPTURE_LOOKBACK_DAYS` (default 3) ET days and skips unchanged matched rows.
  Pass `?sold=1` or `?daily=1` for a forced manual reconciliation.
- **Reads:** forecast (live-quarter realized), export, and drill-down prefer the store
  but only for a range it **fully covers** (`storeCoversRange`), else fall back to
  Maestro — so a gap day is never served as a complete `$0` result. Each store read is
  timeout-guarded so an unreachable/stalled DB falls back instead of hanging.

## Migration / bootstrap
Run `azure-sql/001_create_sold_lots.sql`, then `002_cost_optimizations.sql`, as a SQL admin (they create the schema,
tables, and grants `lqdt_app` ownership of the `lqdt` schema so future migrations run
as `lqdt_app`, no admin needed). Substitute `<<AZURE_SQL_PASSWORD>>` at run time.

## Operational notes
- **Production connectivity:** the app must reach `cl-sql-db-svr`. Azure-internal hosts
  (App Service / Container Apps) are covered by the server's `AllowAzure` firewall rule
  — no public exposure. Vercel's dynamic egress is not, hence the Vercel→Azure Container
  Apps hosting move.
- **Provisioned tier (always-on):** cl-sql-db is a Standard S2 (50 DTU) — no serverless
  auto-pause, so there is no cold-start wake and reads are served from the store without
  a first-query penalty. The store-read timeout is now only a guard against a genuinely
  stalled connection, not a pause. (Watch DTU headroom: a dense single-month raw read is
  the heaviest query; if reads approach the timeout, that's a sign to size up.)
- **Re-backfill / gaps:** re-run `/api/backfill-sold` for any window; MERGE makes it
  idempotent. The read coverage gate means a partially-backfilled range serves from
  Maestro until fully filled.
- **Reconciliation (2025-07-06 → today):** 725,089 lots / ~$888M, within −0.2% of the
  reference CSV (difference is the archive floor shifting 4 days + daily growth).

## Scheduled Container Apps Jobs (resource group `cl-tool-rg`, env `cl-aca-env`)
Container Apps has no built-in cron, so scheduling lives in ACA **Jobs** (created via
`az containerapp job create --yaml`; multi-arg `command` needs the YAML form). All
times are **UTC**.

- **`lqdt-cron`** — the app's data pipeline. Cron `0 0,4,8,12,16,20 * * *` (every 4h).
  Runs `curl -fsS "$APP_URL/api/cron?secret=$CRON_SECRET"` (secret `cron-secret`). The
  scrapers run on every fire, but the once-daily work (`sold_lots` reconciliation, SAM,
  state contracts, retention, forecast snapshot, email) only on the **noon-ET** fire
  (16:00 UTC = noon EDT / 11am EST; gated by `DAILY_INGEST_HOURS_ET=11,12`). Replaced the
  old Vercel cron.
- **`lqdt-sold-capture`** — intraday `sold_lots` refreshes so the *current* day's GMV
  shows up same-day instead of waiting for the next noon reconciliation. Cron
  `0 3,21 * * *` → **~5pm ET** (21:00 UTC — "halfway", ~66% of the day's GMV closed) and
  **~11pm ET** (03:00 UTC — "end", ~99% closed). Runs
  `curl -fsS "$APP_URL/api/cron?sold=1&secret=$CRON_SECRET"`; `sold=1` captures sold lots +
  refreshes the forecast snapshot only, skipping the once-daily email/SAM/state/retention
  (so it never burns the SAM daily quota or re-sends email). Auction closings cluster in
  the evening ET (lot surge 7–10pm; only ~25% of GMV has closed by noon), which is why the
  noon fire alone left the current day near-empty until the next day. Two intraday fires +
  noon cover the day; reverting to every-4h capture is unnecessary cost. Times drift ±1h
  with DST (fixed-UTC cron), but `sold=1` isn't hour-gated so the drift is harmless.
- **`lqdt-keepwarm`** — kills the app cold-start cheaply. Cron `*/4 11-23 * * 1-5`
  (~every 4 min, ~7am–8pm ET weekdays; window shifts ±1h with DST). Runs
  `curl -fsS -o /dev/null "$APP_URL/login"` — a **public** page, so it keeps ≥1 replica
  alive (a request inside the 300s scale-down cooldown prevents scale-to-zero) without a
  session and without touching the DB. The 0.25-vCPU app fits inside Container Apps' free
  monthly grant (~200h), so business-hours warmth is effectively free; it still scales to
  zero overnight/weekends. Pings a **public** page only (no DB): the S2 DB is always-on,
  so there is nothing to keep warm there — this job exists purely to kill the *app*
  replica cold-start.

All three jobs set `APP_URL` to the app's ingress URL. Trigger a manual run to test:
`az containerapp job start -n <job> -g cl-tool-rg`.

## Caching (perceived load speed)
Dashboard pages are `force-dynamic`; a small shared in-memory TTL cache (`src/lib/cache.ts`)
fronts the read-only, user-independent hot paths so repeat navigation skips the
cross-region Supabase round trips: `src/lib/dashboard-data.ts` (listings/contracts/
marketplace, ~60s), `/api/data-status` (~30s), `/api/forecast` (60s). Per-replica, so it
pairs with `lqdt-keepwarm`. TTL env override: `DASHBOARD_CACHE_MS`.

The forecast page's **"Quarterly revenue by category"** chart (`/api/gmv-by-category`) caches
the one expensive step — the Azure SQL `GROUP BY` — keyed by date range (`CATEGORY_CACHE_MS`,
default 15 min). The route returns the top-15 categories (long tail pre-folded into "Other")
and the client folds further to its chosen Top-N (6/8/10) **in memory**, so period and Top-N
toggles reuse the cached rows and never re-hit the DB (previously every toggle re-ran the live
query). First hit per 15-min window is sub-second; every repeat/toggle is instant.
