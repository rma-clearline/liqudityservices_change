// Data reduction helpers for the charting API.

/**
 * Evenly thin an array down to at most `maxPoints` items, preserving the
 * first and last elements. Used to stay within QuickChart's free-tier label
 * cap (250) while keeping the series visually representative.
 *
 * Returns the input unchanged when it is already within the limit.
 */
export function downsample<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints <= 0 || items.length <= maxPoints) return items;

  const step = items.length / maxPoints;
  const indices = Array.from({ length: maxPoints }, (_, i) => Math.round(i * step));
  indices[indices.length - 1] = items.length - 1;
  return indices.map((i) => items[i]);
}

/** QuickChart free tier allows at most this many labels per chart. */
export const MAX_CHART_LABELS = 250;

/**
 * Render a Chart.js (v2) config to a base64 PNG via the QuickChart REST API —
 * the app's server-side static-chart path (email can't run JS). Never throws:
 * returns { image: null, debug } on any network/HTTP error so a chart failure
 * degrades to a text-only email instead of blocking the send.
 */
export async function renderChartPng(
  config: unknown,
  { width = 800, height = 400 }: { width?: number; height?: number } = {},
): Promise<{ image: string | null; debug: string }> {
  try {
    const res = await fetch("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chart: config, width, height, backgroundColor: "white", format: "png", version: "2" }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "(could not read body)");
      return { image: null, debug: `quickchart ${res.status}: ${errBody.slice(0, 300)}` };
    }
    const buffer = await res.arrayBuffer();
    return { image: Buffer.from(buffer).toString("base64"), debug: `ok, ${buffer.byteLength} bytes` };
  } catch (err) {
    return { image: null, debug: `fetch error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
