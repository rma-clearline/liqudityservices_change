import { fetchWithRetry } from "../http";

export type SocrataConfig = {
  portal: string;
  datasetId: string;
  searchTerms?: string[];
  appToken?: string;
};

const SOCRATA_TIMEOUT = 30_000;
const PAGE_SIZE = 1000;
// Cap total rows pulled per dataset so a broad match can't run unbounded.
const MAX_ROWS = Number(process.env.SOCRATA_MAX_ROWS) || 10_000;

/**
 * Fetch rows from a Socrata dataset matching any of the vendor patterns, paging
 * through results via $offset (future_improvements.md "Add Socrata pagination
 * and per-source cursoring").
 * Primary: single combined $where OR query.
 * Fallback: parallel $q queries per pattern (for portals where $where is gated
 * by Cloudflare — e.g. opendata.maryland.gov).
 */
export async function socrataFetchByWhere<T = Record<string, unknown>>(
  cfg: SocrataConfig,
  vendorField: string,
  vendorPatterns: string[],
  limit = MAX_ROWS,
): Promise<T[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.appToken) headers["X-App-Token"] = cfg.appToken;

  const clauses = vendorPatterns.map(
    (pat) => `upper(${vendorField}) like '%${pat.toUpperCase().replace(/'/g, "''")}%'`,
  );
  const where = clauses.join(" OR ");

  const rows: T[] = [];
  for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
    const pageSize = Math.min(PAGE_SIZE, limit - offset);
    const url = new URL(`https://${cfg.portal}/resource/${cfg.datasetId}.json`);
    url.searchParams.set("$where", where);
    url.searchParams.set("$limit", String(pageSize));
    url.searchParams.set("$offset", String(offset));

    try {
      const res = await fetchWithRetry(url.toString(), { headers }, { timeoutMs: SOCRATA_TIMEOUT });
      if (res.status === 403) {
        console.warn(`[socrata] ${cfg.portal}/${cfg.datasetId} $where 403; falling back to $q`);
        return await fetchByQ<T>(cfg, vendorPatterns, headers, limit);
      }
      if (!res.ok) {
        console.error(`[socrata] ${cfg.portal}/${cfg.datasetId} HTTP ${res.status}`);
        break;
      }
      const batch = (await res.json()) as T[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      rows.push(...batch);
      if (batch.length < pageSize) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[socrata] ${cfg.portal}/${cfg.datasetId} error: ${msg}`);
      break;
    }
  }
  return rows;
}

// Fallback: parallel $q per pattern with offset paging; dedup identical rows.
async function fetchByQ<T>(
  cfg: SocrataConfig,
  terms: string[],
  headers: Record<string, string>,
  limit: number,
): Promise<T[]> {
  const perTerm = await Promise.all(
    terms.map(async (term) => {
      const rows: T[] = [];
      for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
        const pageSize = Math.min(PAGE_SIZE, limit - offset);
        const url = new URL(`https://${cfg.portal}/resource/${cfg.datasetId}.json`);
        url.searchParams.set("$q", term);
        url.searchParams.set("$limit", String(pageSize));
        url.searchParams.set("$offset", String(offset));
        try {
          const res = await fetchWithRetry(url.toString(), { headers }, { timeoutMs: SOCRATA_TIMEOUT });
          if (!res.ok) break;
          const batch = (await res.json()) as T[];
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.push(...batch);
          if (batch.length < pageSize) break;
        } catch {
          break;
        }
      }
      return rows;
    }),
  );

  const seen = new Set<string>();
  const out: T[] = [];
  for (const batch of perTerm) {
    for (const row of batch) {
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}
