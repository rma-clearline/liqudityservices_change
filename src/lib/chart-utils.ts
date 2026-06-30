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
