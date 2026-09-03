import { isApiKeyCredential, normalizeApiKey } from "./apikey"
import { KiroAuthError, type KiroCredentialManager } from "./auth"
import type { KiroClientDependencies } from "./client"
import { API_PROVIDER_ID } from "./constants"
import { getApiKeyProfileArn, getProfileArn } from "./profile"

export type KiroSession = {
  authHeaders: () => Promise<Record<string, string>>
  chatProfileArn: () => Promise<string | undefined>
  mcpProfileArn: () => Promise<string>
}

/** Session for the device-flow logins, backed by the refreshing credential manager. */
function createOAuthSession(
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

export function createApiKeySession(key: string, dependencies: KiroClientDependencies = {}): KiroSession {
  const validated = normalizeApiKey(key)

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
      return getApiKeyProfileArn(validated, dependencies)
    },
  }
}

/**
 * What a session is built from. The discriminant is first-class: an OAuth session is backed by
 * the refreshing credential manager (which reads and validates the store itself), an API-key
 * session by the stored credential or, failing that, the key the host read from its environment.
 * Pure over its inputs: the host adapter (plugin.ts) owns every environment read.
 */
export type SessionSpec =
  | { mode: "oauth"; credentials: KiroCredentialManager }
  | { mode: "api"; credential: unknown; envKey?: string }

export function createSession(spec: SessionSpec, dependencies: KiroClientDependencies = {}): KiroSession {
  if (spec.mode === "api") {
    const { credential } = spec
    if (isApiKeyCredential(credential)) return createApiKeySession(credential.key, dependencies)
    if (credential !== undefined) {
      throw new KiroAuthError(
        `The stored ${API_PROVIDER_ID} credential is invalid. ` +
          `Run \`opencode auth login --provider ${API_PROVIDER_ID}\` again.`,
      )
    }
    const envKey = spec.envKey
    if (!envKey) {
      throw new KiroAuthError(
        `No credential found for ${API_PROVIDER_ID}. ` +
          `Run \`opencode auth login --provider ${API_PROVIDER_ID}\`.`,
      )
    }
    return apiKeySessionFromEnv(envKey, dependencies)
  }

  return createOAuthSession(spec.credentials, dependencies)
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
