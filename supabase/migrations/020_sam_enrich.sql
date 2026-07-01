-- Enrich SAM.gov opportunities with fields already present in the v2 search
-- response but previously dropped: set-aside type and place of performance.
-- future_improvements.md "Add SAM.gov opportunity detail enrichment for ...
-- place of performance, set-aside ...".

alter table sam_opportunities add column if not exists set_aside text;
alter table sam_opportunities add column if not exists pop_state text;
alter table sam_opportunities add column if not exists pop_city text;
