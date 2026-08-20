import { createHash } from "node:crypto"
import {
  KIRO_CONTENT_TYPE,
  KIRO_GET_PROFILE_TARGET,
  KIRO_MANAGEMENT_ENDPOINTS,
  KIRO_MGMT_USER_AGENT,
} from "./constants"
import { redactKiroSecrets } from "./debug"

export const API_KEY_PREFIX = "ksk_"

export const API_KEY_ENV_VAR = "KIRO_API_KEY"

export type ApiKeyCredential = {
  type: "api"
  key: string
}

export class KiroApiKeyError extends Error {}

type ApiKeyDependencies = {
  fetch?: typeof globalThis.fetch
}

export function isApiKeyCredential(value: unknown): value is ApiKeyCredential {
  if (!value || typeof value !== "object") return false
  const credential = value as Partial<ApiKeyCredential>
  return credential.type === "api" && typeof credential.key === "string" && credential.key.length > 0
}

export function normalizeApiKey(value: string): string {
  const key = value.trim()
  if (!key) {
    throw new KiroApiKeyError("Kiro API key is empty.")
  }
  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new KiroApiKeyError(
      `Kiro API keys start with "${API_KEY_PREFIX}". Create one at https://app.kiro.dev under Settings -> API Keys.`,
    )
  }
  return key
}

export function readApiKeyFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[API_KEY_ENV_VAR]?.trim()
  return raw ? raw : undefined
}

export async function fetchApiKeyProfileArn(
  key: string,
  dependencies: ApiKeyDependencies = {},
): Promise<string> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const failures: string[] = []

  for (const endpoint of KIRO_MANAGEMENT_ENDPOINTS) {
    let response: Response
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          tokentype: "API_KEY",
          "content-type": KIRO_CONTENT_TYPE,
          "x-amz-target": KIRO_GET_PROFILE_TARGET,
          "user-agent": KIRO_MGMT_USER_AGENT,
          "x-amz-user-agent": KIRO_MGMT_USER_AGENT,
        },
        body: "{}",
      })
    } catch (error) {
      failures.push(`${endpoint}: ${redactKiroSecrets(error instanceof Error ? error.message : String(error))}`)
      continue
    }

    if (!response.ok) {
      failures.push(`${endpoint}: HTTP ${response.status}`)
      continue
    }

    const data = (await response.json().catch(() => null)) as { profile?: { arn?: unknown } } | null
    const arn = data?.profile?.arn
    if (typeof arn === "string" && arn.length > 0) return arn
    failures.push(`${endpoint}: response contained no profile ARN`)
  }

  throw new KiroApiKeyError(
    `Kiro could not resolve this API key's profile via GetProfile (${failures.join("; ")}). ` +
      "Confirm the key is active at https://app.kiro.dev under Settings -> API Keys, then retry.",
  )
}

const PROFILE_CACHE_LIMIT = 8
const profileArnCaches = new WeakMap<typeof globalThis.fetch, Map<string, Promise<string>>>()

function profileCache(fetcher: typeof globalThis.fetch): Map<string, Promise<string>> {
  let cache = profileArnCaches.get(fetcher)
  if (!cache) {
    cache = new Map()
    profileArnCaches.set(fetcher, cache)
  }
  return cache
}

function credentialDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

export function createApiKeySession(key: string, dependencies: ApiKeyDependencies = {}) {
  const validated = normalizeApiKey(key)
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const cache = profileCache(fetcher)
  const cacheKey = credentialDigest(validated)

  return {
    async authHeaders() {
      return {
        authorization: `Bearer ${validated}`,
        tokentype: "API_KEY",
      }
    },
    profileArn() {
      const cached = cache.get(cacheKey)
      if (cached) {
        cache.delete(cacheKey)
        cache.set(cacheKey, cached)
        return cached
      }

      const pending = fetchApiKeyProfileArn(validated, { fetch: fetcher }).catch((error) => {
        if (cache.get(cacheKey) === pending) cache.delete(cacheKey)
        throw error
      })
      if (cache.size >= PROFILE_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      cache.set(cacheKey, pending)
      return pending
    },
    omitProfileArnInBody: true,
  }
}
