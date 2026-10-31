// Panel discovery: which houses have a collectable private-label site?
// For each Invaluable house slug: fetch the PUBLIC house page (10 s crawl-delay),
// read sellerModel.connectBaseUrl (the house's own site, if any) and its catalog
// count, then probe that site's /auctions/past-auctions/ once for hosted-catalog
// links (the WordPress template; the client-rendered template exposes nothing and is
// skipped). Prints one JSON line per house; candidates have pastCatalogs > 0.
//   node scripts/invaluable/discover.mjs <slug-file> [limit]
import { readFileSync } from "node:fs";
import { get, catalogPathsIn } from "./lib.mjs";

const slugs = readFileSync(process.argv[2], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const limit = Number(process.argv[3]) || slugs.length;
const field = (html, key) => {
  const i = html.indexOf('"' + key + '":"');
  if (i < 0) return null;
  const j = html.indexOf('"', i + key.length + 4);
  return j < 0 ? null : html.slice(i + key.length + 4, j);
};
for (const slug of slugs.slice(0, limit)) {
  const out = { slug: slug.replace("/auction-house/", ""), name: null, site: null, catalogsOnInvaluable: 0, pastCatalogs: 0, template: null };
  try {
    const page = await get("https://www.invaluable.com" + slug);
    if (!page) { out.template = "no-page"; console.log(JSON.stringify(out)); continue; }
    out.name = field(page, "sellerName");
    out.catalogsOnInvaluable = new Set([...page.matchAll(/\/catalog\/([A-Z0-9]{10})/g)].map((m) => m[1])).size;
    const site = field(page, "connectBaseUrl");
    if (!site) { out.template = "none"; console.log(JSON.stringify(out)); continue; }
    out.site = site.replace(/\/+$/, "");
    const past = await get(out.site + "/auctions/past-auctions/");
    if (past) {
      const paths = catalogPathsIn(past);
      const salePages = past.split('href="').filter((s) => s.startsWith(out.site + "/auctions/past-auctions/") || s.startsWith("/auctions/past-auctions/")).length;
      out.pastCatalogs = paths.size;
      out.pastSalePages = salePages;
      out.template = paths.size || salePages > 2 ? "wordpress" : "other";
    } else out.template = "no-past-page";
  } catch (e) {
    out.template = "error: " + e.message.slice(0, 60);
  }
  console.log(JSON.stringify(out));
}
