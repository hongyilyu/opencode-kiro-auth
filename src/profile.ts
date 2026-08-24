import { createHash } from "node:crypto"
import { listAvailableProfiles } from "./client"
import { KIRO_PROFILE_ARN_PLACEHOLDER } from "./constants"

type ProfileDependencies = {
  fetch?: typeof globalThis.fetch
}

const PROFILE_CACHE_LIMIT = 8
const profileCaches = new WeakMap<typeof globalThis.fetch, Map<string, Promise<string>>>()

function profileCache(fetcher: typeof globalThis.fetch): Map<string, Promise<string>> {
  let cache = profileCaches.get(fetcher)
  if (!cache) {
    cache = new Map()
    profileCaches.set(fetcher, cache)
  }
  return cache
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

/**
 * Resolve the profileArn the same way kiro-cli does, supporting every account type:
 *   - IdC / enterprise accounts: use the real ARN from ListAvailableProfiles.
 *   - Builder ID accounts (incl. Builder-ID-backed Pro): fall back to the fixed
 *     placeholder kiro-cli itself uses.
 * Results are cached by an access-token digest, rather than globally, so changing
 * accounts cannot reuse another account's profile and the cache retains no token.
 */
export function getProfileArn(accessToken: string, dependencies: ProfileDependencies = {}): Promise<string> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const cache = profileCache(fetcher)
  const cacheKey = tokenDigest(accessToken)
  const cached = cache.get(cacheKey)
  if (cached) {
    cache.delete(cacheKey)
    cache.set(cacheKey, cached)
    return cached
  }

  const pending = listFirstProfileArn(accessToken, fetcher).catch(() => KIRO_PROFILE_ARN_PLACEHOLDER)
  if (cache.size >= PROFILE_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(cacheKey, pending)
  return pending
}

async function listFirstProfileArn(accessToken: string, fetcher: typeof globalThis.fetch): Promise<string> {
  const res = await listAvailableProfiles(accessToken, { fetch: fetcher })
  if (!res.ok) return KIRO_PROFILE_ARN_PLACEHOLDER
  const data = (await res.json().catch(() => null)) as { profiles?: Array<{ arn?: string }> } | null
  const arn = data?.profiles?.find((p) => typeof p.arn === "string" && p.arn.length > 0)?.arn
  return arn ?? KIRO_PROFILE_ARN_PLACEHOLDER
}
