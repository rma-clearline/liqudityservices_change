import { NextResponse } from "next/server";
import { categoryByPeriod, fetchSoldRange, type ExportPeriod } from "@/lib/sold-export";
import { etTodayKey, quarterBounds } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriod(v: string | null): ExportPeriod {
  return v === "day" || v === "week" || v === "month" || v === "quarter" ? v : "quarter";
}

// Quarterly (or other) revenue-by-category, sourced from the Maestro sold
// archive (value-ranked, capped) so an outsized/one-time category is visible.
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
    const fetched = await fetchSoldRange(from, to);
    const { categories, data } = categoryByPeriod(fetched.rows, period, topN);
    return NextResponse.json({
      from,
      to,
      period,
      categories,
      data,
      total_in_range: fetched.total_in_range,
      truncated: fetched.truncated,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
