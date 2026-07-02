# Runbook — Fixing empty/stale Marketplace, Federal & State data

This documents what was wrong, what code changed, and the **manual steps only you can do**
(apply DB migrations, regenerate the SAM key, deploy). Diagnosis was done by probing every
source live and querying the deployed Supabase directly.

## TL;DR — the sources are fine; the pipeline drifted

| Complaint | Reality | Action |
|---|---|---|
| Marketplace metrics "empty" | Source healthy (Maestro AD ~29k / GD ~26k). Latest row was **all zeros** (a transient fetch wrote `emptyMetrics`), and the new dashboard reads enrichment columns **missing from prod**. | Code guard added; **apply migrations 014, 017**; deploy. |
| Federal contracts "stale" | USAspending works, but LQDT is a *seller*, not a prime recipient — ~6 lifetime awards, newest 2020, ~$0. Structurally sparse. | Relabeled honestly + broadened names. Real federal signal = SAM + the new Government Sellers widget. |
| State contracts "stale" | Source fresh (WA "Liquidity Services Operations LLC", 2026). Frozen by `ignoreDuplicates` + no new distinct rows since 4/24. Riverside adapter just wasn't deployed. | Switched to merge upsert; **apply migrations 021, 023**; deploy. |
| SAM opportunities "empty" | Two causes: the key had lapsed (404), **and** the cron fired ~10 SAM calls every 4h, blowing the small daily quota (HTTP 429). | Key **regenerated & working**; SAM now gated to **once/day**; 429 vs 404 reported distinctly. Set key in Vercel. |

## Manual steps (in order)

### 1. Apply DB migrations to prod Supabase (SQL Editor)
These are **not applied** in prod (verified: `cron_runs` 404s, `marketplace_metrics.reserve_rate` doesn't exist).
Run these, in order, from `supabase/migrations/`:

- `014_create_cron_runs.sql` — ops log + powers freshness/alerts (`/api/data-status`).
- `015_create_fx_rates.sql` — reproducible FX (if not already applied).
- `013_enrich_auctions.sql`, `017_marketplace_metrics_enrich.sql` — columns the new ingester/dashboard write & read (`reserve_rate`, `listings_with_reserve`, `pages_fetched`, `is_full_coverage`).
- `018`–`020`, `022` — RLS/enrich/index (per prior plan).
- `021_state_contracts_record_type.sql` — **required** or the state upsert's `onConflict` (which names `record_type`) breaks.
- `023_state_contracts_last_seen.sql` — **new**: adds `last_seen_date` + a trigger that preserves `first_seen_date` on update. Apply this **before** the deploy so the merge upsert doesn't overwrite first-seen dates.

> Order matters only for 021/023 relative to the deploy: apply them **before** deploying the new cron. The freshness reader already falls back to `first_seen_date` if `last_seen_date` is missing, so nothing breaks if there's a gap.

### 2. SAM.gov API key — DONE (key works), but mind the daily quota
- ✅ **Key regenerated and confirmed working** (2026-07-01): `GET /opportunities/v2/search` returns HTTP 200 with live data (32,041 opportunities in a 90-day window). Set locally in `.env`.
- **Set it in Vercel too:** `SAM_API_KEY` in **Project → Settings → Environment Variables** (prod ingestion needs it).
- ⚠️ **Daily quota is the real constraint.** SAM personal keys have a small daily request quota. One `fetchSamOpportunities` run fires ~10 requests (probe + 5 brand-title + 4 NAICS searches). The cron used to run this every 4h (~60 req/day) → **HTTP 429 "Message throttled out"** → nothing stored. This was a major reason the table stayed empty even before the key lapsed.
  - **Fix applied:** SAM now runs **once per day** (the noon ET cron, or `?sam=1` / `?sendEmail=1` to force). The code also stops probing on the first 429 and reports "throttled (key valid, quota exhausted)" distinctly from "unauthorized (404)".
  - If the quota is still too low (e.g. ~10/day), either trim the brand-title/NAICS query list in `sam-opportunities.ts`, or request a **federal/system account** (1,000/day) for a larger allowance.
- ⏳ **Still unverified:** whether the brand-title / NAICS-award strategy actually surfaces LQDT-relevant opportunities — testing hit the daily quota (resets 00:00 UTC). Re-validate after reset; if it comes back empty, pivot the SAM query from "opportunities *naming* LQDT" to the **federal surplus-disposal pipeline** (keyword search: surplus / disposal / auction of personal property), which is what LQDT actually bids on.

### 3. Deploy the branch
The deployed app is running **old** code (marketplace samples only 50 listings; no Riverside; no enrichment).
Deploy the current branch to Vercel. After deploy, the cron (every 4h) will:
- sample thousands per platform and **skip writing zero rows** (no more blank "latest" marketplace view);
- **merge** state rows (refresh amounts) and advance `last_seen_date`;
- pick up the **Riverside** adapter (adds GovDeals rows) and the broadened federal name search.

## Verify after steps 1–3
Trigger a run and re-check:
```
curl "https://<app>/api/cron?secret=$CRON_SECRET&sendEmail=0"
```
- `marketplace_metrics` latest row is **non-zero** and `is_full_coverage`/`sample_size` populated.
- `state_contracts` `last_seen_date` = today; existing rows' amounts refreshed; `first_seen_date` unchanged.
- `sam_opportunities` > 0 (once the key is valid).
- `cron_runs` has a row per source; `/api/data-status` shows green badges; the alerts banner clears.
- Contracts page → **Government Surplus Sellers** widget shows the federal/state/local/commercial mix with a working level filter.

## What changed in code (this session)
- `src/app/api/cron/route.ts` — marketplace: skip zero-row writes; state: merge-on-conflict + `last_seen_date`.
- `supabase/migrations/023_state_contracts_last_seen.sql` — **new**.
- `src/app/api/data-status/route.ts` — state freshness uses `last_seen_date` (fallback `first_seen_date`).
- `src/lib/contracts.ts` — broadened LQDT name variants; honest sparse-lens comment.
- `src/lib/gov-seller.ts` — **new** government-level classifier + aggregation.
- `src/components/government-sellers.tsx` — **new** filterable government-seller mix widget.
- `src/app/(dashboard)/contracts/page.tsx` — added Government Sellers section; relabeled Federal + SAM with context notes.
- `src/components/section-header.tsx` — optional `note` line.
- `src/lib/sam-opportunities.ts` — 404 now reported as an auth/key problem, not an outage.
- `src/lib/supabase.ts` — `StateContractRow.last_seen_date`.
