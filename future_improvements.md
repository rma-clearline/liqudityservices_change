# future_improvements

## Next

- Replace current FX historical GMV conversion with sale-date FX. Store native sale amount, native currency, sale-date USD rate, converted USD amount, and rate source so historical GMV can be reproduced and audited.

## Forecasting and Auction Data

- Add a verified sold-results feed or settlement source so closed auctions with bids can be classified as sold only when reserve/settlement status is known.
- Backtest the projection model against historical quarters and report error by platform, category, price band, bid band, and days-to-close.
- Add forecast confidence intervals using historical model error rather than showing only a single-point estimate.
- Add seasonality features for quarter-end, weekday/weekend close dates, holidays, and known large-event auction days.
- Persist forecast snapshots and the feature mix behind each projection so quarter-over-quarter changes can be explained.
- Enrich auction rows with reserve status when available, auction type, event ID, seller segment, geography, equipment/asset condition, watch count, listing duration, and normalized title keywords.
- Separate current-bid GMV proxy from realized GMV in reporting and database naming.

## Data Quality and Operations

- Move cron writes to a server-only Supabase service role while keeping browser reads on anon keys with least-privilege RLS policies.
- Add a cron run log table with start/end time, source-level status, row counts, errors, and duration for each scraper.
- Split expensive cron work into smaller jobs so a slow external source does not block all daily updates.
- Add retry/backoff and source-specific timeouts for Maestro, USAspending, SAM.gov, state portals, FX, and email.
- Add validation checks for historical CSV schema, date coverage, duplicate rows, and GMV totals before using exports in production forecasts.
- Add alerting for stale data, failed cron runs, unexpectedly low row counts, and large day-over-day GMV swings.
- Add rate limiting and chart image size limits to the manual snapshot endpoint.

## Marketplace Metrics

- Store metrics coverage metadata, including fetched pages, sample size, total listings, and whether the snapshot is full coverage or sampled.
- Consider a background full-crawl mode for seller and category metrics when API limits allow it.
- Track seller-level changes over time, including new sellers, disappearing sellers, listing count deltas, and top asset deltas.

## Contracts and Opportunities

- Paginate USAspending contract pulls beyond the current request window and persist source query metadata.
- Normalize federal award types and separate active contract value, new obligation, and ceiling value where available.
- Add SAM.gov opportunity detail enrichment for NAICS, PSC, place of performance, set-aside, awardee, attachments, and response deadlines.
- Separate state/local contract records by record type and source semantics so awards, solicitations, purchase orders, and amendments are not blended.
- Add Socrata pagination and per-source cursoring for state/local portals.
- Improve vendor normalization with aliases, punctuation handling, common suffix stripping, and manual overrides for known strategic accounts.

## Reporting

- Add a reconciliation view that compares daily historical GMV, tracked sold auctions, projected remaining GMV, and total forecast in one place.
- Add source freshness indicators to dashboard sections so stale data is obvious.
- Add exportable forecast and sales-detail tables for downstream analysis.
