# GMV bugs: root-cause & fix

Two GMV defects on the Forecast tab, diagnosed against live data (dev server + the
historical CSV + Maestro sold-archive probes). Numbers are as measured on
2026-07-02.

---

## Bug 1 — "Total GMV (all data)" was slightly inflated by a projection

### Symptom
In the **All (full history)** view, the "Total GMV (all data)" headline card didn't
match the realized-only monthly/quarterly growth table (and the realized chart
bars).

### Measured
| Figure | Value |
|---|---|
| Card `projected_total_gmv_usd` | **$897.07M** |
| Sum of daily **realized** GMV | **$895.35M** |
| Growth-table total (realized) | **$895.35M** |
| Difference | **$1.72M (0.19%)** |

### Root cause
`computeRevenueForecast` (`src/lib/auctions.ts`) computed the headline total as
`Σ (realized_gmv_usd + projected_gmv_usd)` over the daily series. The All view's
range runs to the **current quarter end** (a future date, 2026-09-30), so the
current quarter's **open-auction projection (~$1.72M)** was added to what is billed
as an "all data" (i.e. historical, realized) number. The daily chart also stacks
realized + projected, so the card matched the *chart's stacked bars* — but not the
realized-only growth table, creating the apparent inconsistency. (Per-source
AD+GD+GI reconciles exactly to $895.35M; the CSV's realized total is $882.25M and
the extra ~$13M is current-quarter tracked sales not yet in the CSV — not a bug.)

### Fix
Added `realized_total_gmv_usd` / `realized_total_revenue_usd` (realized only) to the
forecast. The All-view headline now uses the realized total ($895.35M), matching the
growth table and realized bars. Single-quarter views keep `projected_total_*`
(realized + projection = the forecast), which is correct for a forecast card. The
chart still shows the small projected sliver, clearly labeled "Projected".

---

## Bug 2 — the export dropped ~31% of GMV, and a *wider* range dropped *more*

### Symptom
Exporting lost a large amount of GMV vs the true realized total (~$882M). Setting the
start **before data began** (e.g. 2025-04-25) lost *even more* — the opposite of what
you'd expect from a wider range.

### Measured
| Scenario | Lots in range (Maestro) | Lots captured | GMV captured | Loss vs $882.25M |
|---|---|---|---|---|
| True total (historical CSV, business_id=ALL) | — | — | **$882.25M** | — |
| Export, 2025-07-15 → 2026-07-02 | 831,417 | 43,504 (5.2%) | **$605.66M** | **−$276.6M (31%)** |
| Export, 2025-04-25 → 2026-07-02 | 824,753 | 46,807 (5.7%) | **$629.79M** | −$252.5M (29%) |

In a **throttled** run (Maestro returning 400/429 under load) the earlier-start export
fell to **~$380M** — the worst-case the user observed.

### Root cause
`fetchSoldRange` in `src/lib/sold-export.ts` split the range into ~weekly chunks and
then capped **total** fetched pages at `PAGE_BUDGET = 60`:

```
pagesPerChunk   = max(1, floor(60 / chunks.length))   // ~51 weeks → 1 page/week
budgetForDeeper = max(0, 60 - chunks.length)          // deeper (page ≥2) pages
```

Three compounding failures:

1. **Undersized budget → value-ranked sampling.** With ~51 weekly chunks it fetched
   only **~1 page (top ~1,000 of ~16,000 lots) per week** — dropping ~94% of each
   week's lots. Because pages are sorted by `currentBid desc`, it kept the highest-
   value lots (so it captured ~69% of GMV from ~5% of lots), but still lost ~31%.

2. **Phase-2 collapse past 60 chunks.** `budgetForDeeper = 60 − chunks.length` hits
   **0 once there are >60 chunks**. Extending the start to 2025-04-25 adds ~11 empty
   **pre-archive** weekly chunks (the sold archive only goes back to ~mid-July 2025),
   pushing the chunk count past 60 → **no deeper pages at all**. So a wider range
   could capture *less* — a monotonicity violation and a cliff at exactly 60 chunks.

3. **Silent chunk drops under throttling.** Maestro 400s/429s when many page requests
   fire concurrently. If a chunk's page failed after retries, that **entire week
   contributed 0**, silently. More chunks (wider range) → more concurrent requests →
   more throttling → more dropped weeks. This is why a bad run of the wider range
   collapsed to ~$380M.

### Fix
`fetchSoldRange` now fetches **every page of every non-empty chunk** (complete
coverage) instead of a value-ranked sample:

- **No page budget.** Each week is paged to exhaustion (`2 … ceil(total/1000)`); a
  high `maxPages` safety cap (default 500) only bounds a single request. A quarter
  (~200 pages) completes and is *not* truncated.
- **Empty chunks are skipped** (page-1 `total === 0`), so pre-archive weeks can't
  distort budgets or waste requests.
- **Harder retries** (4 attempts, exponential backoff) at bounded concurrency (5) so
  a transient throttle no longer silently zeroes a week; a genuinely failed chunk is
  reported as partial rather than dropped.
- **Per-quarter splitting in the export modal.** Since a full-history complete fetch
  (~830 pages, ~90–120s) exceeds the 60s serverless limit, the modal splits any range
  wider than a quarter into **per-quarter requests** (each complete, ~20–30s), shows
  progress, and concatenates the CSVs (quarters are date-disjoint, so no cross-quarter
  duplicates). Result: full-history export now reconciles to ~$882M, and a wider range
  never captures less (monotonic).
- **Category chart stays a fast sample.** `/api/gmv-by-category` passes `maxPages: 80`
  — it only needs to surface outsized categories, and it labels the result a sample.

---

## Bonus — invalid dates are no longer selectable

The export's default `from` was the earliest **quarter start** (e.g. 2025-04-01),
which is months before any data — directly feeding Bug 2's empty pre-archive chunks.
Now the forecast exposes `earliest_data_date` (~2025-06-30) and both the export
From/To pickers and the QTD-as-of picker are bounded (`min`/`max`) and clamped to the
actual data range, so a query can never span dates with no GMV data. The export
default `from` is the earliest data date.

## Verification
- `/api/forecast?quarter=ALL` → `realized_total_gmv_usd` ≈ $895.35M; All-view card,
  growth table, and realized bars agree.
- Single-quarter export → `truncated=false`, pivot GMV reconciles to that quarter's
  realized total. Full-history export → per-quarter progress; assembled GMV ≈ $882M
  (no ~31% loss); a 2025-04-25 start no longer reduces the total.
- Date pickers reject dates before ~2025-06-30 or after today.
