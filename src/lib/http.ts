// Shared fetch with per-call timeout + exponential backoff on transient
// failures. Used by the non-Maestro scrapers (USAspending, SAM, Socrata) so
// retry/timeout behavior is consistent. future_improvements.md "Add
// retry/backoff and source-specific timeouts".

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FetchRetryOptions = {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
};

/**
 * fetch() with timeout + retry. Retries on network error, timeout, 429, and
 * 5xx; returns the last Response otherwise. Throws only if every attempt threw.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { timeoutMs = 20_000, retries = 2, backoffMs = 500 }: FetchRetryOptions = {},
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      return res; // non-retryable (4xx) or out of retries — let caller inspect
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
