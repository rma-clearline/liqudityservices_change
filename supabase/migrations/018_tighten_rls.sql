-- Least-privilege RLS. Writes now go through the Supabase service role (see
-- supabaseAdmin in src/lib/supabase.ts), which bypasses RLS, so the broad anon
-- write policies added in migration 012 are no longer needed. Dropping them
-- makes the anon/publishable key (used for browser + server reads) read-only.
-- future_improvements.md "Move cron writes to a server-only Supabase service
-- role while keeping browser reads on anon keys with least-privilege RLS".

drop policy if exists "Allow anon insert" on auctions;
drop policy if exists "Allow anon update" on auctions;

-- All data tables retain their "public read" select policies for the anon key.
-- (fx_rates and cron_runs, added in 014/015, already ship with public read.)
