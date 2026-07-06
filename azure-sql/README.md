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
- **Daily capture:** the cron (`/api/cron`) `sold_lots` task writes the last
  `SOLD_CAPTURE_LOOKBACK_DAYS` (default 3) ET days each run — bounded by a 45s timeout.
- **Reads:** forecast (live-quarter realized), export, and drill-down prefer the store
  but only for a range it **fully covers** (`storeCoversRange`), else fall back to
  Maestro — so a gap day is never served as a complete `$0` result. Each store read is
  timeout-guarded so a cold/paused DB falls back instead of hanging.

## Migration / bootstrap
`azure-sql/001_create_sold_lots.sql` — run once as a SQL admin (it creates the schema,
tables, and grants `lqdt_app` ownership of the `lqdt` schema so future migrations run
as `lqdt_app`, no admin needed). Substitute `<<AZURE_SQL_PASSWORD>>` at run time.

## Operational notes
- **Production connectivity:** the app must reach `cl-sql-db-svr`. Azure-internal hosts
  (App Service / Container Apps) are covered by the server's `AllowAzure` firewall rule
  — no public exposure. Vercel's dynamic egress is not, hence the Vercel→Azure Container
  Apps hosting move.
- **Serverless auto-pause:** the DB pauses after 60 min idle; the first query after a
  pause takes ~30–60s to wake, during which reads fall back to Maestro. Disable
  auto-pause (control-plane) if always-instant reads matter (adds ~always-on cost).
- **Re-backfill / gaps:** re-run `/api/backfill-sold` for any window; MERGE makes it
  idempotent. The read coverage gate means a partially-backfilled range serves from
  Maestro until fully filled.
- **Reconciliation (2025-07-06 → today):** 725,089 lots / ~$888M, within −0.2% of the
  reference CSV (difference is the archive floor shifting 4 days + daily growth).
