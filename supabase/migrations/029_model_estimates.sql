-- Analyst-editable company guidance + Clearline GMV estimates, keyed by calendar
-- quarter ("YYYYQn"). A row here OVERRIDES that quarter's values from the model
-- workbook export (the gitignored CSV pushed to the app as a Container App secret),
-- so analysts can update guidance/estimates from the QTD page without touching the
-- model or redeploying.
--
-- SECURITY: unlike the other tables, this one has NO public-read policy — the
-- Clearline estimate is proprietary (deliberately kept out of git), so reads and
-- writes both go through the service-role client inside session-gated API routes.
create table if not exists model_estimates (
  quarter                 text primary key check (quarter ~ '^\d{4}Q[1-4]$'),
  guidance_low_usd        bigint check (guidance_low_usd  is null or guidance_low_usd  > 0),
  guidance_high_usd       bigint check (guidance_high_usd is null or guidance_high_usd > 0),
  clearline_estimate_usd  bigint check (clearline_estimate_usd is null or clearline_estimate_usd > 0),
  updated_by              text,
  updated_at              timestamptz not null default now()
);

alter table model_estimates enable row level security;
-- (no policies: anon/publishable keys can neither read nor write; service role bypasses RLS)
