/**
 * One bounded, promise-sharing memo for the plugin's three "resolve once per credential/client"
 * lookups (OAuth profile ARN, API-key profile ARN, opencode context limits).
 *
 * The memo owns the mechanics; the loader owns the policy:
 *   - a loader that RESOLVES (even to a fallback) is cached like any value;
 *   - a loader that REJECTS is evicted, so the next call retries.
 *
 * Keys are caller-supplied strings (callers memoizing by credential pass a digest, so the memo
 * never holds a raw secret). Scopes are objects held weakly (a fetch function, an opencode client),
 * which is what lets tests isolate themselves by handing in a fresh instance.
 */
export type AsyncMemo<Scope extends WeakKey, Value> = {
  /**
   * Resolve `key` under `scope`. Concurrent callers share one in-flight load. A hit refreshes
   * recency; at `limit` the least-recently-used key is evicted before insert. A rejected load is
   * evicted only while it is still the current entry, so an old failure never evicts a newer load.
   */
  resolve(scope: Scope, key: string, load: () => Promise<Value>): Promise<Value>
}

export function createAsyncMemo<Scope extends WeakKey, Value>(options: { limit: number }): AsyncMemo<Scope, Value> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new RangeError(`createAsyncMemo: limit must be a positive integer, got ${options.limit}`)
  }
  const scopes = new WeakMap<Scope, Map<string, Promise<Value>>>()

  function entries(scope: Scope): Map<string, Promise<Value>> {
    let map = scopes.get(scope)
    if (!map) {
      map = new Map()
      scopes.set(scope, map)
    }
    return map
  }

  return {
    resolve(scope, key, load) {
      const map = entries(scope)
      const cached = map.get(key)
      if (cached) {
        map.delete(key)
        map.set(key, cached)
        return cached
      }

      const pending: Promise<Value> = load().catch((error: unknown) => {
        if (map.get(key) === pending) map.delete(key)
        throw error
      })
      while (map.size >= options.limit) map.delete(map.keys().next().value!)
      map.set(key, pending)
      return pending
    },
  }
}
