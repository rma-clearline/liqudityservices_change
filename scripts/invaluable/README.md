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
- Full catalogs without the search backend: a catalog's lots occupy a contiguous block
  of numeric ids, so the collector anchors on page 1 and sweeps outward through the
  lot API until `nbHits` lots are in (25 consecutive foreign ids end a direction).
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

- Price basis is per catalog (`resultsIncludePremium`); the lot API's `buyersPremium`
  is a naive rate × result and is used only to recover the rate.
- Ties and absentee bids executed by the house can mis-classify a lot; the
  online-won flag is an inference, unvalidated against any disclosed GMS so far.
- Currency is native per lot; FX conversion is not yet applied.
- Regenerating these modules through a Bash heredoc collapses doubled backslashes;
  use the editor tools for files with regex escapes.
