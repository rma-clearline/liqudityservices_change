# Forecast page: default take rate from the Clearline model

## Problem

The Forecast tab's take-rate input defaults to a hardcoded `0.2`. Twenty percent is
roughly double the rate this page's GMV actually earns, so every revenue figure on the
tab — headline cards, per-platform blocks, the daily revenue series, the category
revenue chart — reads about 2x high out of the box.

The default should be the take rate we calculate, not a placeholder.

## What the rate is

`consignment_take_rate` from the Clearline workbook (`scripts/model-metrics-quarterly.csv`,
already loaded by `/api/forecast` via `loadModelMetrics()`): reported revenue divided by
consignment (non-purchase) GMV — the model's own auction-marketplace take rate.

Two independent methods agree on it, which is why it was chosen over the alternatives:

| Source | Rate |
|---|---|
| CL model `consignment_take_rate` — FQ4 FY25 / FQ1 FY26 / FQ2 FY26 | 11.19% / 11.16% / 11.18% |
| Our per-lot measured fees (bid-box premium + seller admin), hammer basis, all-time | 11.20% |

The model is top-down from reported financials; our measurement is bottom-up from
per-lot fees in `lqdt.sold_lots ⋈ lqdt.seller_fees`. They land 2bp apart.

### Alternatives rejected

- **Full workbook blended take (~31%).** `reconstructed ÷ (GovDeals + RSCG + CAG GMV)`.
  Its denominator is ~$390M/quarter against this page's ~$207–240M, because it includes
  RSCG (~$113M at a 73.6% take) which has no counterpart in `sold_lots` at all. Applying
  it here would price marketplace GMV at a rate driven by a segment that GMV excludes.
- **GovDeals+CAG segment blend weighted by our site mix (~10.6%).** Defensible, but it
  swings 10.2–11.0% by quarter and reads ~5 points light against segment revenue capture:
  our GMV is ~89% GovDeals while the model's segments are ~77%, and CAG carries a far
  richer take (17% vs 10%), so a mix-weighted blend sits below the segment average.
- **Our measured rate directly (11.20% hammer / 10.12% premium-inclusive).** Equivalent in
  practice, but sourcing from the model keeps the page consistent with the workbook the
  rest of the dashboard benchmarks against.

## Design

### Rate resolution — `src/lib/reported-gmv.ts`

```
consignmentTakeRate(metrics, preferQuarter?) -> {
  rate, source: "model_consignment" | "fallback", quarter, kind
}
```

Prefers the displayed quarter's own `consignment_take_rate`; otherwise the most recent
quarter that has one. Values outside `(0, 1)` are ignored. With none available it returns
`0.2` and `source: "fallback"`, so the page degrades to today's behavior.

Only reported quarters carry `consignment_take_rate`, so the live quarter and the ALL view
resolve to the latest reported quarter (currently FQ2 FY26, 11.18%).

### API — `src/app/api/forecast/route.ts`

`takeRate` present in the query string still wins. When absent, the route applies the
resolved rate instead of `0.2`. The payload gains `default_take_rate` (the whole
resolution object) so the UI can label the number and it stays auditable.

Rate resolution moves below the existing `loadModelMetrics()` call — no new query, no new
I/O; the metrics are already loaded for the reported-GMV benchmark.

### Client — `src/components/revenue-forecast.tsx`

`takeRate` starts `null` and the param is omitted on the first request, so the server
decides. The first response's `take_rate` becomes the input's value. The input stays
freely editable; a caption names the source, e.g. *"calculated 11.18% — Clearline model
consignment take rate (FQ2 FY26)"*.

`CategoryRevenueChart` receives the resolved rate and needs no change.

### Scope note

Only the Forecast tab is affected. `qtd-progress.tsx` pins `takeRate=1` explicitly and the
cron's snapshot is computed at rate 1, so both are untouched.

## Auctions-only note

`SectionHeader` already supports a `note` prop, so the Forecast page passes a one-line
note clarifying that the tab covers auction marketplace GMV only — it excludes RSCG
purchase/resale and Machinio, and so does not reconcile to total company revenue.

This matters precisely because of the rejected-alternatives analysis above: the page's
GMV is ~53% of the workbook's total GMV base, and a reader comparing these revenue
figures to reported company revenue would otherwise be confused.

## Expected effect

Revenue on the tab falls by roughly half. 2026Q2 realized revenue goes from about $48M
at 20% to about $27M at 11.18%. GMV figures are unchanged.

Cross-checked against the model per quarter: our implied revenue tracks our GMV capture of
the GovDeals+CAG segments (70–75%) to within a few points, with the residual explained by
our GovDeals-heavy mix.

## Verification

- `consignmentTakeRate` returns 11.18% (FQ2 FY26, reported) for the live quarter, the
  quarter's own rate for a reported historical quarter, and `0.2`/`fallback` from an
  empty metrics array.
- `/api/forecast` with no `takeRate` returns `take_rate` ≈ 0.1118; with `takeRate=0.25`
  returns 0.25 — the override still wins.
- Typecheck and production build clean.
