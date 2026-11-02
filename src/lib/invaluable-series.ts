// Series math for the Invaluable panel page: period rows from /api/invaluable turned
// into chart rows (shares, the strict-to-loose range, like-for-like Y/Y, open-period
// flag) plus the per-house folding for stacked bars. Pure; tests in
// tests/invaluable-series.test.mjs. Mirrors scripts/invaluable-report.mjs.

export type Grain = "quarter" | "month";

/** One panel period from /api/invaluable (USD). */
export type PeriodRow = {
  period: string; // YYYYQn or YYYY-MM
  houses: number;
  sold: number;
  thv_usd: number;
  online_usd: number;
  online_lots: number;
  online_loose_usd: number;
  timed_usd: number;
};

/** One house in one period. */
export type HousePeriodRow = { period: string; house: string; thv_usd: number; online_usd: number };

/** Like-for-like growth: only houses with sales in both the period and its prior-year
 *  period, so a house joining the panel never reads as growth. The dollar-weighted
 *  figure can be carried by one large house; the median is the equal-weight view. */
export type LikeForLike = {
  n: number;
  hammerYoy: number | null;
  onlineYoy: number | null;
  medianOnlineYoy: number | null;
  nMedian: number;
};

export type SeriesRow = {
  period: string;
  /** The period containing today (incomplete): drawn muted, no Y/Y. */
  open: boolean;
  houses: number;
  sold: number;
  thv: number;
  online: number;
  loose: number;
  /** loose - online, the width of the strict-to-loose range (never negative). */
  looseExtra: number;
  timed: number;
  share: number | null;
  shareLoose: number | null;
  shareTimed: number | null;
  lfl: LikeForLike;
};

const EMPTY_LFL: LikeForLike = { n: 0, hammerYoy: null, onlineYoy: null, medianOnlineYoy: null, nMedian: 0 };

/** "2026Q1" -> "2025Q1", "2026-03" -> "2025-03". */
export function priorPeriod(p: string): string {
  return String(Number(p.slice(0, 4)) - 1) + p.slice(4);
}

/** The period label that contains `todayIso` (YYYY-MM-DD). */
export function openPeriod(grain: Grain, todayIso: string): string {
  if (grain === "month") return todayIso.slice(0, 7);
  const month = Number(todayIso.slice(5, 7));
  return todayIso.slice(0, 4) + "Q" + (Math.floor((month - 1) / 3) + 1);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function likeForLike(byHouse: HousePeriodRow[], period: string): LikeForLike {
  const prior = priorPeriod(period);
  const cur = new Map<string, HousePeriodRow>();
  const prev = new Map<string, HousePeriodRow>();
  for (const r of byHouse) {
    if (r.period === period) cur.set(r.house, r);
    else if (r.period === prior) prev.set(r.house, r);
  }
  let n = 0, thv = 0, pthv = 0, onl = 0, ponl = 0;
  const perHouse: number[] = [];
  for (const [house, a] of cur) {
    const b = prev.get(house);
    if (!b || a.thv_usd <= 0 || b.thv_usd <= 0) continue;
    n++;
    thv += a.thv_usd; pthv += b.thv_usd; onl += a.online_usd; ponl += b.online_usd;
    if (a.online_usd > 0 && b.online_usd > 0) perHouse.push(a.online_usd / b.online_usd - 1);
  }
  return {
    n,
    hammerYoy: n > 0 && pthv > 0 ? thv / pthv - 1 : null,
    onlineYoy: n > 0 && ponl > 0 ? onl / ponl - 1 : null,
    medianOnlineYoy: median(perHouse),
    nMedian: perHouse.length,
  };
}

export function buildSeries(periods: PeriodRow[], byHouse: HousePeriodRow[], grain: Grain, todayIso: string): SeriesRow[] {
  const open = openPeriod(grain, todayIso);
  return periods.map((p) => {
    const isOpen = p.period >= open;
    const thv = p.thv_usd;
    const ratio = (x: number) => (thv > 0 ? x / thv : null);
    return {
      period: p.period,
      open: isOpen,
      houses: p.houses,
      sold: p.sold,
      thv,
      online: p.online_usd,
      loose: p.online_loose_usd,
      looseExtra: Math.max(0, p.online_loose_usd - p.online_usd),
      timed: p.timed_usd,
      share: ratio(p.online_usd),
      shareLoose: ratio(p.online_loose_usd),
      shareTimed: ratio(p.timed_usd),
      lfl: isOpen ? EMPTY_LFL : likeForLike(byHouse, p.period),
    };
  });
}

export type FoldedHouses = { houses: string[]; rows: Record<string, number | string>[] };

/** Per-period values for the `maxSeries` largest houses (by total over `periods`, a
 *  fixed order so colors follow houses, not ranks) with the rest folded into "Other". */
export function foldHouses(byHouse: HousePeriodRow[], periods: string[], metric: "online_usd" | "thv_usd", maxSeries = 7): FoldedHouses {
  const want = new Set(periods);
  const totals = new Map<string, number>();
  for (const r of byHouse) if (want.has(r.period)) totals.set(r.house, (totals.get(r.house) ?? 0) + r[metric]);
  const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h]) => h);
  const keep = ranked.length > maxSeries ? ranked.slice(0, maxSeries) : ranked;
  const houses = ranked.length > keep.length ? [...keep, "Other"] : keep;
  const kept = new Set(keep);
  const rows = periods.map((period) => {
    const row: Record<string, number | string> = { period };
    for (const h of houses) row[h] = 0;
    for (const r of byHouse) {
      if (r.period !== period) continue;
      const key = kept.has(r.house) ? r.house : "Other";
      row[key] = (Number(row[key]) || 0) + r[metric];
    }
    return row;
  });
  return { houses, rows };
}

export type HouseRow = { house: string; thv: number; online: number; share: number | null; hammerYoy: number | null; onlineYoy: number | null };

/** A period's houses, largest online-won first, each against its own prior year. */
export function houseRows(byHouse: HousePeriodRow[], period: string): HouseRow[] {
  const prior = priorPeriod(period);
  const prev = new Map(byHouse.filter((r) => r.period === prior).map((r) => [r.house, r] as const));
  return byHouse
    .filter((r) => r.period === period)
    .map((a) => {
      const b = prev.get(a.house);
      return {
        house: a.house,
        thv: a.thv_usd,
        online: a.online_usd,
        share: a.thv_usd > 0 ? a.online_usd / a.thv_usd : null,
        hammerYoy: b && b.thv_usd > 0 ? a.thv_usd / b.thv_usd - 1 : null,
        onlineYoy: b && b.online_usd > 0 ? a.online_usd / b.online_usd - 1 : null,
      };
    })
    .sort((x, y) => y.online - x.online);
}

export function latestClosed(rows: SeriesRow[]): SeriesRow | null {
  for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].open) return rows[i];
  return null;
}

/** What Invaluable has disclosed, platform-wide, to read the panel against. */
export const DISCLOSED = {
  /** "Record 14.7% share of gavel", Q1 2026 (Invaluable release, 2026-06-18). */
  shareOfGavel: 0.147,
  /** Growth points: Q1-26 overall GMS $125M +17%; May-26 net GMS +20%. */
  yoy: [
    { grain: "quarter" as const, period: "2026Q1", yoy: 0.17, label: "Q1-26 GMS +17%" },
    { grain: "month" as const, period: "2026-05", yoy: 0.2, label: "May-26 net GMS +20%" },
  ],
};

/** One house-month from the store (USD): the single query /api/invaluable runs. */
export type HouseMonthRow = {
  house: string;
  month: string; // YYYY-MM
  sold: number;
  thv_usd: number;
  online_usd: number;
  online_lots: number;
  online_loose_usd: number;
  timed_usd: number;
};

/** Map rows from the lqdt.inv_house_month rollup (DB column names, values possibly
 *  strings or null) into HouseMonthRow. The rollup already holds the USD aggregate,
 *  so the API feeds these straight to rollupPeriods without scanning lots. */
export function rollupRowsFromDb(rows: Record<string, unknown>[]): HouseMonthRow[] {
  const num = (v: unknown) => Number(v) || 0;
  return rows.map((x) => ({
    house: String(x.house_key),
    month: String(x.month),
    sold: num(x.sold),
    thv_usd: num(x.thv_usd),
    online_usd: num(x.online_usd),
    online_lots: num(x.online_lots),
    online_loose_usd: num(x.online_loose_usd),
    timed_usd: num(x.timed_usd),
  }));
}

/** "2026-02" -> "2026Q1" (calendar quarter; Invaluable discloses calendar periods). */
export function quarterOf(month: string): string {
  return month.slice(0, 4) + "Q" + (Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1);
}

/** Month and quarter panel totals plus per-house rows, rolled up from house-months. */
export function rollupPeriods(rows: HouseMonthRow[]): { month: PeriodRow[]; quarter: PeriodRow[]; byHouse: { month: HousePeriodRow[]; quarter: HousePeriodRow[] } } {
  const build = (key: (month: string) => string) => {
    const totals = new Map<string, PeriodRow & { houseSet: Set<string> }>();
    const perHouse = new Map<string, HousePeriodRow>();
    for (const r of rows) {
      const period = key(r.month);
      const t = totals.get(period) ?? { period, houses: 0, sold: 0, thv_usd: 0, online_usd: 0, online_lots: 0, online_loose_usd: 0, timed_usd: 0, houseSet: new Set<string>() };
      t.sold += r.sold;
      t.thv_usd += r.thv_usd;
      t.online_usd += r.online_usd;
      t.online_lots += r.online_lots;
      t.online_loose_usd += r.online_loose_usd;
      t.timed_usd += r.timed_usd;
      t.houseSet.add(r.house);
      totals.set(period, t);
      const hk = period + "|" + r.house;
      const h = perHouse.get(hk) ?? { period, house: r.house, thv_usd: 0, online_usd: 0 };
      h.thv_usd += r.thv_usd;
      h.online_usd += r.online_usd;
      perHouse.set(hk, h);
    }
    const periods = [...totals.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map(({ houseSet, ...t }) => ({ ...t, houses: houseSet.size }));
    const houses = [...perHouse.values()].sort((a, b) => a.period.localeCompare(b.period) || a.house.localeCompare(b.house));
    return { periods, houses };
  };
  const m = build((x) => x);
  const q = build(quarterOf);
  return { month: m.periods, quarter: q.periods, byHouse: { month: m.houses, quarter: q.houses } };
}
