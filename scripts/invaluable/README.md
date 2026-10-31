# Invaluable / AuctionZip panel tracker

A proxy for Invaluable's reported GMS (gross merchandise sales), built from a panel of
auction houses whose hosted catalogs are collected in full. Collection is
**permission-based** (confirmed 2026-10-30); the client identifies itself
(`lib.mjs` UA, with contact email), spaces requests (2/s per host; 10 s on
invaluable.com, its published crawl-delay), backs off on 429/5xx and stops a host
that blocks it. It never reads invaluable.com's subscriber-gated pages or its search
backend.

## Why a panel, and what the number is

Invaluable's GMS is the hammer value won **through its online channel**, about 15% of
the hammer of the auctions it hosts ("share of gavel"). Scraped hammer is therefore
not GMV; the online-won slice has to be inferred per lot. The platform's top online
bid is hammer-basis and the posted result may include the buyer's premium; after
normalising, `online bid == result` identifies a lot won on the platform
(`deriveLot()`). Timed sales are online by construction. Per house and month the
collector yields total hammer (THV), online-won $ (the GMS proxy), online lot share
and timed vs live THV; `node scripts/invaluable-collect.mjs --summary-only` prints it.

Treat the series as a growth index until it has been validated against two or three
disclosed GMS quarters; levels depend on the panel's share of the platform.

## Data paths (all open endpoints)

- `www.auctionzip.com` is a gateway for every house on the platform:
  `/api/auctions/catalog/<ref>` (meta: date, live/timed, premium schedule, house,
  `resultsIncludePremium`), `/api/auctions/lot/<numeric id | ref>` (result, premium,
  online bid, bid count, estimates) and the page `/auction-catalog/catalog_<ref>`
  (search envelope `nbHits` + the first 20 lot ids).
- Full catalogs: the house site's own `/api/auctions/catalog/<ref>/lots?page=N&size=500`
  returns every lot as a paged list (exact; one request per 500 lots). Its `price` is
  the hammer-basis top online bid, which is the field the online-won test uses: the
  per-lot API's `currentBidAllIn` is computed with the house's CURRENT premium
  schedule and mis-measures older sales. The id sweep from the page-1 anchors remains
  only as a fallback for hosts without the list (edited catalogs scatter lots across
  id blocks, so the sweep is not exact).
- Live sales also require at least one online bid for an online win: with none,
  `price` is the opening bid and a floor buyer paying exactly that would read as online.
- `node scripts/invaluable-report.mjs [--grain quarter]` prints the panel series in
  USD (fx_rates, stored as units per USD), online share, Y/Y, and the disclosed
  reference points to validate against. `scripts/invaluable/discover.mjs <slug-file>`
  walks public Invaluable house pages at the crawl delay, reads each house's
  `connectBaseUrl`, and probes its site for the past-auctions structure.
- Catalog discovery per house kind (`invaluable-panel.json`):
  `private_label` — the house's own site (`sellerModel.connectBaseUrl`) lists past
  sales (`past_list`), each linking its hosted catalog;
  `invaluable` — the public house page `/auction-house/<slug>` lists `/catalog/<ref>`.
  `catalogs` can seed explicit refs for either kind.

## Running

    node scripts/invaluable-collect.mjs                 # every enabled house, resume
    node scripts/invaluable-collect.mjs --house grogan  # one house
    node scripts/invaluable-collect.mjs --max-catalogs 5
    node scripts/invaluable-collect.mjs --refresh       # re-collect complete catalogs
    node scripts/invaluable-collect.mjs --summary-only  # monthly read, no collection

Idempotent MERGEs into `lqdt.inv_houses`, `lqdt.inv_catalogs`, `lqdt.inv_lots`
(migration `azure-sql/017_invaluable_panel.sql`). Catalog `status`: upcoming |
pending | partial | complete | no-page | no-meta. A full house backfill is a few
thousand requests (one per lot); run it in the background.

## Known limits

- Price basis is per catalog (`resultsIncludePremium`). The premium rate itself is
  resolved per lot (next section); the lot API's `buyersPremium` and the schedule
  are only candidates.
- Ties and absentee bids executed by the house can mis-classify a lot; the
  online-won flag is an inference, unvalidated against any disclosed GMS so far.
- Currency is native per lot; the report, the API and the page convert with
  `lqdt.fx_rates` (stored as units per USD) at the sale date.
- Regenerating these modules through a Bash heredoc collapses doubled backslashes;
  use the editor tools for files with regex escapes.

## Panel discovery and reading the numbers (2026-10-31)

Private-label houses are found by probing an established house's own domain:
`/api/auctions/catalog/ZZZZZZZZZZ` answers with a Spring-style JSON 404 on platform
sites; then either `/auctions/past-auctions/` links the catalogs directly or
`/hksn-preview-sale-sitemap.xml` lists one page per sale, each linking its catalog
(`sale_sitemap` in the panel). Client-rendered sites (e.g. live.clars.com) expose
nothing and are skipped. Run one house per invocation.

The series is published as a range: **strict** online-won (top online bid equals the
result AND at least one online bid) and **loose** (equality alone, an upper bound).
Y/Y is **like-for-like** — only houses with sales in both periods, with the count
shown — so a house joining never reads as growth; the open period is flagged.
Regional houses run 2–9% online share vs the platform's 14.7%, which is expected
and why levels are not comparable to disclosed GMS; growth is the comparable.

## Premium-rate resolution (2026-10-31)

Where results are posted premium-inclusive, hammer = result ÷ (1 + rate), and the
rate is not reliably known: the lot API's `buyersPremium` is a naive rate × result
that can carry a different schedule from the one the results embed (Crescent City
reports 23% while its results divide cleanly at the 28% schedule; Grogan is the
reverse, the current 30–33% schedule against the 25–28% in force at the sale).
With the wrong rate the hammer is never equal to the top online bid, so every online
win is missed — Crescent City read 0 online lots on $7M of hammer.

`lib.mjs` now resolves the rate per lot: candidates are the schedule rate plus
every distinct naive lot rate in the catalog (`rateCandidates`); a result that
divides to a whole-dollar hammer under exactly one candidate takes it (`lotRate`,
bids move in whole increments); otherwise the catalog's dominant rate, the one that
makes the most results whole (`dominantRate`). The collector applies it per
catalog (`catalogRates`); `node scripts/invaluable-rederive.mjs` recomputes stored
lots from their raw fields (idempotent). Effect of the first run: Crescent City 0 →
1,431 online lots ($0.79M), Fontaine's +$0.55M, Selkirk 19 → 212 lots; 2026Q1
like-for-like online-won Y/Y moved from +64% to +30% against the disclosed +17%.
`npm test` covers the resolution and the page's series math.

## The dashboard page

`/invaluable` (tab "Invaluable") charts `/api/invaluable`: online-won hammer as
a strict-to-loose range, online share against the disclosed 14.7%, like-for-like
Y/Y (dollar-weighted, median house, hammer) with the disclosed platform growth
points, the stack by house, per-house share panels, and the period and house
tables. Series math lives in `src/lib/invaluable-series.ts`.
