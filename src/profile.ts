import { createHash } from "node:crypto"
import { fetchApiKeyProfileArn } from "./apikey"
import { listAvailableProfiles, type KiroClientDependencies } from "./client"
import { KIRO_PROFILE_ARN_PLACEHOLDER } from "./constants"
import { createAsyncMemo } from "./memo"

/**
 * Credential -> profile ARN, memoized per fetch implementation and keyed by a digest of the
 * credential (the cache retains no token; changing accounts cannot reuse another account's
 * profile). Separate instances keep separate budgets for the two credential kinds.
 */
const PROFILE_CACHE_LIMIT = 8
const oauthProfileArns = createAsyncMemo<typeof globalThis.fetch, string>({ limit: PROFILE_CACHE_LIMIT })
const apiKeyProfileArns = createAsyncMemo<typeof globalThis.fetch, string>({ limit: PROFILE_CACHE_LIMIT })

function credentialDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

/**
 * Resolve the profileArn for an OAuth access token the same way kiro-cli does:
 *   - IdC / enterprise accounts: the real ARN from ListAvailableProfiles;
 *   - Builder ID accounts (incl. Builder-ID-backed Pro): the fixed placeholder kiro-cli itself uses.
 * ListAvailableProfiles is unauthorized for Builder ID, so a 4xx (or an empty list) is the
 * authoritative answer and is cached. A 5xx or transport failure degrades THIS request to the
 * placeholder without being cached, so the next request retries. Never rejects.
 */
export function getProfileArn(accessToken: string, dependencies: KiroClientDependencies = {}): Promise<string> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  return oauthProfileArns
    .resolve(fetcher, credentialDigest(accessToken), () => listFirstProfileArn(accessToken, fetcher))
    .catch(() => KIRO_PROFILE_ARN_PLACEHOLDER)
}

/**
 * Resolve the profileArn for an API key (region fall-through lives in apikey.ts). A rejected
 * lookup is not cached, so a transient outage is retried on the next call.
 */
export function getApiKeyProfileArn(apiKey: string, dependencies: KiroClientDependencies = {}): Promise<string> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  return apiKeyProfileArns.resolve(fetcher, credentialDigest(apiKey), () =>
    fetchApiKeyProfileArn(apiKey, { fetch: fetcher }),
  )
}

async function listFirstProfileArn(accessToken: string, fetcher: typeof globalThis.fetch): Promise<string> {
  const res = await listAvailableProfiles(accessToken, { fetch: fetcher })
  if (res.status >= 500) throw new Error(`ListAvailableProfiles failed (${res.status})`)
  if (!res.ok) return KIRO_PROFILE_ARN_PLACEHOLDER
  const data = (await res.json().catch(() => null)) as { profiles?: Array<{ arn?: string }> } | null
  const arn = data?.profiles?.find((p) => typeof p.arn === "string" && p.arn.length > 0)?.arn
  return arn ?? KIRO_PROFILE_ARN_PLACEHOLDER
}
