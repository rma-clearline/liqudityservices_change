# Design: fully-automatic reported-GMV pipeline

**Status: PROPOSED — not implemented.** This documents how to make LQDT's reported (total-company)
GMV refresh itself with zero manual action. Today the numbers are refreshed manually: update the
model, run `node scripts/extract-reported-gmv.mjs`, commit the CSV, push, and deploy.

## Goal
Reported GMV (the benchmark the scraped/projected GMV is compared against on the Forecast tab)
updates on its own after LQDT reports each quarter — no local command, no commit, no deploy.

## The one hard constraint
The source of truth is a **local file** — `scripts/LQDT Nums v*.xlsm` in the user's OneDrive. It is
proprietary, gitignored, versioned (`v15`, `v16`, …), and never committed. The deployed app runs in
Azure Container Apps and cannot reach a local file. **So "fully automatic" requires a cloud process
that can read that workbook where it lives — i.e. via Microsoft 365 / OneDrive.** Everything after
that (parse → store → render) is straightforward and reuses code we already have.

## Architecture

```
Microsoft 365 (OneDrive / SharePoint)          Azure                         Supabase          App
┌───────────────────────────────┐   Graph API   ┌──────────────────────┐   upsert   ┌───────────────┐   read
│ LQDT Nums v*.xlsm  (the model) │ ─────────────▶│ scheduled cron job:  │ ──────────▶│ reported_gmv  │◀───────  /api/forecast
└───────────────────────────────┘  download bytes│  fetch → parse → save│            │  (quarter PK) │          → chart + table
                                                  └──────────────────────┘            └───────────────┘
```

1. **Trigger** — a scheduled ACA Job (or a step in the existing `lqdt-cron`) fires on a cadence.
2. **Fetch** — it authenticates to Microsoft Graph (app-only) and downloads the latest workbook.
3. **Parse** — the existing zero-dependency OOXML extractor (refactored into a shared module) turns
   the workbook bytes into the quarterly series.
4. **Validate + store** — sanity-check the series, then upsert into a Supabase `reported_gmv` table.
5. **Serve** — `/api/forecast` reads `reported_gmv` (DB-first, committed CSV as fallback); the chart
   and quarterly table render it exactly as they do today.

## Components

### 1. Source access — Microsoft Graph → OneDrive/SharePoint
- **Auth: app-only (client-credentials).** Unattended cron has no signed-in user, so a delegated
  refresh-token flow is brittle (tokens rotate/expire). Register an **Entra application** with a
  client secret (or certificate) and grab an app-only token:
  `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
  (`grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`).
- **Permission scope — the key security decision:**
  - **Preferred (least privilege):** move the model into a **dedicated SharePoint document library**
    (or a shared site folder) and grant the app **`Sites.Selected`** (application), admin-consented to
    *only that site*. The app can read nothing else in the tenant.
  - **If the model must stay in personal OneDrive:** app-only access to a personal OneDrive requires
    **`Files.Read.All`** (application), which can read *every* user's OneDrive org-wide and needs admin
    consent. That is broad — flag it to whoever approves it. `Sites.Selected` does **not** cover
    personal OneDrive, only SharePoint sites.
- **Locating the file (filename is versioned):** list the target folder and pick the newest match:
  `GET /drives/{driveId}/root:/{folder}:/children` → filter `^LQDT Nums v.*\.xlsm$` → highest
  version / newest `lastModifiedDateTime`. **Recommendation:** to make this robust, keep the model in
  a **stable folder** where only the current model lives, or adopt a **stable filename**
  (e.g. `LQDT Model - current.xlsm`). Otherwise a rename/move breaks the lookup.
- **Download:** `GET /drives/{driveId}/items/{itemId}/content` → the `.xlsm` bytes as a Buffer.

### 2. Parse (reuse existing code)
- Refactor the extraction core out of `scripts/extract-reported-gmv.mjs` into a shared module, e.g.
  `src/lib/reported-gmv-extract.ts`, exporting `extractReportedQuarterly(buf: Buffer): { quarter,
  quarter_end, reported_gmv_usd }[]`. The CLI script and the cron both call it.
- The logic is unchanged and already proven: read the `Model` sheet, find the `Total GMV` row by its
  column-A label, take the quarterly date-header block, keep past integer (reported, not
  model-forecast) quarter-end columns, convert `$000 → USD`, key by calendar `YYYYQn`.
- It is **zero-dependency** (Node `zlib` + a tiny ZIP/OOXML reader) — no `xlsx`/`exceljs` needed, so
  it runs anywhere the app runs. It reads only two rows; all macros and other sheets are ignored.

### 3. Store — Supabase `reported_gmv`
- New migration `supabase/migrations/029_reported_gmv.sql`, following the `fx_rates` /
  `forecast_snapshots` pattern:
  ```sql
  create table if not exists reported_gmv (
    quarter           text primary key,        -- calendar YYYYQn
    quarter_end       date not null,
    reported_gmv_usd  bigint not null,
    updated_at        timestamptz not null default now()
  );
  alter table reported_gmv enable row level security;
  create policy "Public read access" on reported_gmv for select using (true);
  ```
- Writes via `supabaseAdmin` (service role) from the cron; reads via the anon client.
- **`/api/forecast` change:** `loadReportedQuarterlyGmv()` (`src/lib/reported-gmv.ts`) reads the table
  first and falls back to the committed CSV when the table is empty/unreachable. The CSV stays in the
  repo as a **seed/backup**, so the app is never worse off than today.

### 4. Trigger — scheduled refresh
- Add a machine-authenticated route `GET /api/cron/reported-gmv?secret=$CRON_SECRET` (a public/machine
  bypass path like `/api/cron` and `/api/backfill-sold`) that does fetch → parse → validate → upsert.
- Schedule it as an ACA Job (mirrors `lqdt-cron` / `lqdt-sold-capture` in `azure-sql/README.md`), or
  fold a call into the existing daily `lqdt-cron` fire. **Cadence: weekly is plenty** — the number
  changes ~4×/year, right after earnings; the upsert is idempotent so extra runs are harmless.

### 5. Config / secrets (ACA secrets — never committed)
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` (or a certificate).
- File locator: `GRAPH_DRIVE_ID` + folder path, or a pinned `GRAPH_WORKBOOK_ITEM_ID`.
- Reuse the existing `CRON_SECRET` to gate the route.

## Validation & failure modes
- **Sanity-check before upsert** (guards against a silently-changed model layout corrupting the
  chart): require e.g. ≥ N quarters, strictly-positive values, plausible magnitude band, and a
  monotonic quarter sequence. If it fails, **skip the upsert and log** — never overwrite good data
  with garbage.
- **Idempotent + last-known-good:** upsert by `quarter`; a failed fetch/parse leaves the previous rows
  intact. The forecast route's CSV fallback covers a totally-empty table.
- **Alerting:** log to `cron_runs` (existing) and surface failures through the existing cron/email
  path so a broken pull is visible.

## Alternatives considered
- **Local scheduled task (no cloud/Graph).** A Windows Task Scheduler job on the analyst's machine
  runs a push script daily / on file-change (OneDrive keeps the file synced locally). Zero cloud
  setup and no broad Graph permission, but it depends on that machine being on and holds the Supabase
  service key locally. Good middle ground if the Graph permissioning is unwelcome; effectively the
  "one command, instant" option on a timer.
- **Power Automate flow on file-change.** Rejected: its Excel connector targets tables/named ranges in
  `.xlsx`; the model reads specific cell positions in a macro workbook, so extraction there is
  unreliable. Graph-download + our own parser is far more robust.

## Cost
~$0 incremental. Graph API calls are free within normal limits; the ACA cron infra already exists; the
Supabase table is trivial; an Entra app registration is free.

## Phased implementation (each step independently shippable)
1. **DB-back the series (no Graph yet):** add `029_reported_gmv.sql`; make `loadReportedQuarterlyGmv()`
   read DB-first with CSV fallback; add a local `scripts/push-reported-gmv.mjs` that extracts + upserts.
   → This already delivers "one command, instant" and is the safe foundation.
2. **Refactor extraction** into `src/lib/reported-gmv-extract.ts` shared by the CLI and server.
3. **Add Graph fetch** + the `/api/cron/reported-gmv` route (fetch → parse → validate → upsert).
4. **Provision + schedule:** Entra app registration, decide the permission scope (SharePoint
   `Sites.Selected` vs OneDrive `Files.Read.All`), set ACA secrets, create the ACA Job.

## Prerequisites / open questions for the user
- **Where should the model live for the cloud to read it?** A dedicated SharePoint library (enables
  least-privilege `Sites.Selected`) is strongly preferred over personal OneDrive (which forces the
  broad `Files.Read.All`).
- **Stable filename or folder?** Needed so the automation reliably finds the current model despite the
  `v15/v16` versioning.
- **Who can grant admin consent** for the Graph permission and create the Entra app registration?
- **Is reading the proprietary workbook into Azure acceptable?** Only the derived quarterly totals are
  persisted; the workbook itself is read transiently in memory and never stored — but it does transit
  cloud infra, which is worth an explicit OK.
