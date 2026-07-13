import { NextResponse } from "next/server";
import { categoryByPeriod, fetchSoldRange, type ExportPeriod } from "@/lib/sold-export";
import { getCategoryDaily, isAzureSqlConfigured } from "@/lib/azure-sql";
import { etTodayKey, quarterBounds } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriod(v: string | null): ExportPeriod {
  return v === "day" || v === "week" || v === "month" || v === "quarter" ? v : "quarter";
}

// Revenue-by-category composition. Prefer the durable Azure store: one indexed
// GROUP BY returns complete, deduped (incl. GI) composition in well under a
// second. The old path pulled the ENTIRE range from Maestro live (value-ranked,
// paged in weekly chunks), which on the chart's full-history range exceeded
// maxDuration — the container was killed mid-request and the ingress returned a
// plaintext "upstream connect error ..." body that broke the client's JSON parse
// ("Unexpected token 'u'"). Maestro stays the fallback only when the store is
// unconfigured or empty for the range.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cur = quarterBounds(new Date());
  let from = (searchParams.get("from") ?? "").trim();
  let to = (searchParams.get("to") ?? "").trim();
  if (!DATE_RE.test(from)) from = cur.start.toISOString().slice(0, 10);
  if (!DATE_RE.test(to)) to = etTodayKey();
  if (from > to) [from, to] = [to, from];
  const period = parsePeriod(searchParams.get("period"));
  const topN = Math.max(3, Math.min(15, Number(searchParams.get("topN")) || 8));

  try {
    if (isAzureSqlConfigured()) {
      // Time-box the store read (serverless DB may be resuming). On timeout/error
      // return clean JSON — never fall through to a full-range Maestro pull with
      // little budget left, which is what let the ingress emit a non-JSON body.
      const timeoutMs = Number(process.env.CATEGORY_STORE_TIMEOUT_MS) || 40_000;
      let daily;
      try {
        daily = await Promise.race([
          getCategoryDaily(from, to),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("category store timeout")), timeoutMs)),
        ]);
      } catch {
        return NextResponse.json(
          { error: "Category breakdown is temporarily unavailable (database resuming) — please retry." },
          { status: 503 },
        );
      }
      if (daily.length > 0) {
        const rows = daily.map((d) => ({ category: d.category, close_date_et: d.date, sale_amount_usd: d.gmv }));
        const { categories, data } = categoryByPeriod(rows, period, topN);
        // Store data is complete (not a value-ranked sample), so truncated=false.
        return NextResponse.json({ from, to, period, categories, data, truncated: false, source: "store" });
      }
      // Store has no rows for this range (e.g. entirely pre-store) — fall through.
    }

    // Fallback: Maestro sold archive (value-ranked, bounded pages).
    const fetched = await fetchSoldRange(from, to, { maxPages: 60 });
    const { categories, data } = categoryByPeriod(fetched.rows, period, topN);
    return NextResponse.json({
      from,
      to,
      period,
      categories,
      data,
      total_in_range: fetched.total_in_range,
      truncated: fetched.truncated,
      source: "maestro",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
