import { createHash } from "node:crypto"
import {
  fetchApiKeyProfileArn,
  isApiKeyCredential,
  normalizeApiKey,
  readApiKeyFromEnv,
} from "./apikey"
import { KiroAuthError, requireOAuthCredential, type KiroCredentialManager } from "./auth"
import type { KiroClientDependencies } from "./client"
import { API_PROVIDER_ID } from "./constants"
import { getProfileArn } from "./profile"

export type KiroSession = {
  authHeaders: () => Promise<Record<string, string>>
  chatProfileArn: () => Promise<string | undefined>
  mcpProfileArn: () => Promise<string>
}

/** Session for the device-flow logins, backed by the refreshing credential manager. */
export function createOAuthSession(
  credentials: KiroCredentialManager,
  dependencies: KiroClientDependencies = {},
): KiroSession {
  let accessToken: Promise<string> | undefined
  const token = () => (accessToken ??= credentials.getAccessToken())
  const profileArn = async () => getProfileArn(await token(), dependencies)

  return {
    async authHeaders() {
      return { authorization: `Bearer ${await token()}` }
    },
    chatProfileArn: profileArn,
    mcpProfileArn: profileArn,
  }
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

export function createApiKeySession(key: string, dependencies: KiroClientDependencies = {}): KiroSession {
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
    async chatProfileArn() {
      return undefined
    },
    mcpProfileArn() {
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
  }
}

type SessionDependencies = KiroClientDependencies & {
  readEnvKey?: () => string | undefined
  mode?: "oauth" | "api"
}

export function createSession(
  credential: unknown,
  credentials?: KiroCredentialManager,
  dependencies: SessionDependencies = {},
): KiroSession {
  const mode = dependencies.mode ?? "oauth"
  const readEnvKey = dependencies.readEnvKey ?? readApiKeyFromEnv

  if (mode === "api") {
    if (isApiKeyCredential(credential)) return createApiKeySession(credential.key, dependencies)
    if (credential !== undefined) {
      throw new KiroAuthError(
        `The stored ${API_PROVIDER_ID} credential is invalid. ` +
          `Run \`opencode auth login --provider ${API_PROVIDER_ID}\` again.`,
      )
    }
    const envKey = readEnvKey()
    if (!envKey) {
      throw new KiroAuthError(
        `No credential found for ${API_PROVIDER_ID}. ` +
          `Run \`opencode auth login --provider ${API_PROVIDER_ID}\`.`,
      )
    }
    return apiKeySessionFromEnv(envKey, dependencies)
  }

  requireOAuthCredential(credential)
  if (!credentials) throw new KiroAuthError("Kiro OAuth credential manager is unavailable.")
  return createOAuthSession(credentials, dependencies)
}

function apiKeySessionFromEnv(envKey: string, dependencies: KiroClientDependencies): KiroSession {
  try {
    return createApiKeySession(envKey, dependencies)
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "")
    throw new KiroAuthError(
      `The configured Kiro credential is unusable: ${detail}. ` +
        `Fix it or run \`opencode auth login --provider ${API_PROVIDER_ID}\`.`,
    )
  }
}
