// Invaluable panel collector — Azure SQL access (same lqdt_app credentials as the app).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sql = require("mssql");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function connect() {
  const env = {};
  for (const l of readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const cfg = { server: env.AZURE_SQL_SERVER, database: env.AZURE_SQL_DATABASE, user: env.AZURE_SQL_USER, options: { encrypt: true, useUTC: true }, requestTimeout: 120_000 };
  cfg.password = env.AZURE_SQL_PASSWORD;
  return sql.connect(cfg);
}

export async function upsertHouse(pool, h) {
  await pool.request().input("k", sql.NVarChar(40), h.key).input("n", sql.NVarChar(200), h.name ?? null)
    .input("d", sql.NVarChar(200), h.domain).input("kind", sql.NVarChar(20), h.kind)
    .input("sid", sql.Int, h.sellerId ?? null).input("sref", sql.NVarChar(20), h.sellerRef ?? null)
    .query(`MERGE lqdt.inv_houses WITH (HOLDLOCK) AS t USING (SELECT @k AS house_key) s ON t.house_key=s.house_key
      WHEN MATCHED THEN UPDATE SET name=COALESCE(@n,t.name), domain=@d, kind=@kind, seller_id=COALESCE(@sid,t.seller_id), seller_ref=COALESCE(@sref,t.seller_ref)
      WHEN NOT MATCHED THEN INSERT (house_key,name,domain,kind,seller_id,seller_ref) VALUES (@k,@n,@d,@kind,@sid,@sref);`);
}

export async function upsertCatalog(pool, c) {
  await pool.request().input("ref", sql.NVarChar(20), c.ref).input("h", sql.NVarChar(40), c.houseKey)
    .input("t", sql.NVarChar(300), (c.title ?? "").slice(0, 300)).input("p", sql.NVarChar(400), c.path ?? null)
    .input("dl", sql.Date, c.eventDateLocal ? new Date(c.eventDateLocal + "T00:00:00Z") : null)
    .input("du", sql.DateTime2, c.eventTsUtc ? new Date(c.eventTsUtc) : null)
    .input("live", sql.Bit, c.isLive).input("timed", sql.Bit, c.isTimed).input("incl", sql.Bit, c.resultsIncludePremium)
    .input("rate", sql.Decimal(6, 4), c.premiumRate).input("cur", sql.NVarChar(8), c.currency ?? null)
    .input("nb", sql.Int, c.nbLots ?? null).input("lf", sql.Int, c.lotsFetched ?? 0).input("st", sql.NVarChar(20), c.status)
    .query(`MERGE lqdt.inv_catalogs WITH (HOLDLOCK) AS t USING (SELECT @ref AS catalog_ref) s ON t.catalog_ref=s.catalog_ref
      WHEN MATCHED THEN UPDATE SET house_key=@h,title=@t,path=COALESCE(@p,t.path),event_date_local=@dl,event_ts_utc=@du,is_live=@live,is_timed=@timed,
        results_include_premium=@incl,premium_rate=@rate,currency=COALESCE(@cur,t.currency),nb_lots=COALESCE(@nb,t.nb_lots),lots_fetched=@lf,status=@st,fetched_at=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (catalog_ref,house_key,title,path,event_date_local,event_ts_utc,is_live,is_timed,results_include_premium,premium_rate,currency,nb_lots,lots_fetched,status)
        VALUES (@ref,@h,@t,@p,@dl,@du,@live,@timed,@incl,@rate,@cur,@nb,@lf,@st);`);
}

/** Catalogs already complete for a house (skipped unless --refresh). */
export async function completeRefs(pool, houseKey) {
  const r = await pool.request().input("h", sql.NVarChar(40), houseKey).query("SELECT catalog_ref FROM lqdt.inv_catalogs WHERE house_key=@h AND status='complete'");
  return new Set(r.recordset.map((x) => x.catalog_ref));
}

/** Bulk upsert of derived lot rows via OPENJSON (one round trip per catalog). */
export async function upsertLots(pool, rows) {
  if (!rows.length) return;
  await pool.request().input("j", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(`
    MERGE lqdt.inv_lots WITH (HOLDLOCK) AS t
    USING (SELECT * FROM OPENJSON(@j) WITH (
      lot_ref NVARCHAR(20) '$.lot_ref', lot_id BIGINT '$.lot_id', catalog_ref NVARCHAR(20) '$.catalog_ref', lot_number NVARCHAR(20) '$.lot_number',
      title NVARCHAR(400) '$.title', category NVARCHAR(120) '$.category', subcategory NVARCHAR(120) '$.subcategory',
      estimate_low DECIMAL(18,2) '$.estimate_low', estimate_high DECIMAL(18,2) '$.estimate_high', is_sold BIT '$.is_sold', is_passed BIT '$.is_passed',
      price_result DECIMAL(18,2) '$.price_result', premium_rate DECIMAL(6,4) '$.premium_rate', hammer DECIMAL(18,2) '$.hammer',
      online_all_in DECIMAL(18,2) '$.online_all_in', online_hammer DECIMAL(18,2) '$.online_hammer', bid_count INT '$.bid_count',
      online_won BIT '$.online_won', currency NVARCHAR(8) '$.currency')) AS s ON t.lot_ref=s.lot_ref
    WHEN MATCHED THEN UPDATE SET lot_id=s.lot_id,catalog_ref=s.catalog_ref,lot_number=s.lot_number,title=s.title,category=s.category,subcategory=s.subcategory,
      estimate_low=s.estimate_low,estimate_high=s.estimate_high,is_sold=s.is_sold,is_passed=s.is_passed,price_result=s.price_result,premium_rate=s.premium_rate,
      hammer=s.hammer,online_all_in=s.online_all_in,online_hammer=s.online_hammer,bid_count=s.bid_count,online_won=s.online_won,currency=s.currency,fetched_at=SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (lot_ref,lot_id,catalog_ref,lot_number,title,category,subcategory,estimate_low,estimate_high,is_sold,is_passed,price_result,premium_rate,hammer,online_all_in,online_hammer,bid_count,online_won,currency)
      VALUES (s.lot_ref,s.lot_id,s.catalog_ref,s.lot_number,s.title,s.category,s.subcategory,s.estimate_low,s.estimate_high,s.is_sold,s.is_passed,s.price_result,s.premium_rate,s.hammer,s.online_all_in,s.online_hammer,s.bid_count,s.online_won,s.currency);`);
}

/** Monthly panel read (what the view would have been). */
export async function monthlySummary(pool, houseKey) {
  const r = await pool.request().input("h", sql.NVarChar(40), houseKey ?? null).query(`
    SELECT c.house_key, DATEFROMPARTS(YEAR(c.event_date_local), MONTH(c.event_date_local), 1) AS month,
      COUNT(DISTINCT c.catalog_ref) AS catalogs, COUNT(l.lot_ref) AS lots, SUM(CASE WHEN l.is_sold=1 THEN 1 ELSE 0 END) AS sold,
      SUM(CASE WHEN l.is_sold=1 THEN l.hammer ELSE 0 END) AS thv, SUM(CASE WHEN l.online_won=1 THEN l.hammer ELSE 0 END) AS online_won,
      SUM(CASE WHEN l.online_won=1 THEN 1 ELSE 0 END) AS online_lots, SUM(CASE WHEN c.is_timed=1 AND l.is_sold=1 THEN l.hammer ELSE 0 END) AS thv_timed
    FROM lqdt.inv_catalogs c JOIN lqdt.inv_lots l ON l.catalog_ref=c.catalog_ref
    WHERE c.status IN ('complete','partial') AND c.lots_fetched >= 0.9 * c.nb_lots AND (@h IS NULL OR c.house_key=@h)
    GROUP BY c.house_key, DATEFROMPARTS(YEAR(c.event_date_local), MONTH(c.event_date_local), 1) ORDER BY 1, 2`);
  return r.recordset;
}
