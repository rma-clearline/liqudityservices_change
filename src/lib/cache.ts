// Small shared in-memory TTL cache for read-only, user-independent server data.
//
// Per-replica (a module-level Map), so it pairs with the business-hours keep-warm:
// the container stays alive during work hours, so cached entries survive across
// requests and repeat navigation is instant. Generalizes the inline pattern used
// by `rangeCache` in sold-export.ts and the forecast route.
//
// Only cache data that is the SAME for every (authenticated) user and never
// mutated in place by callers. Errors are not cached — a failed `load` is retried
// on the next call.

type Entry<T> = { at: number; val: T };

export type TtlCache<T> = {
  /** Return the cached value if still fresh, else run `load`, store, and return it. */
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Invalidate one key, or all keys when called with no argument. */
  clear(key?: string): void;
};

export function ttlCache<T>(ttlMs: number): TtlCache<T> {
  const store = new Map<string, Entry<T>>();
  return {
    async get(key, load) {
      const hit = store.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.val;
      const val = await load();
      store.set(key, { at: Date.now(), val });
      return val;
    },
    clear(key) {
      if (key === undefined) store.clear();
      else store.delete(key);
    },
  };
}
