import { createApiKeySession, isApiKeyCredential, readApiKeyFromEnv } from "./apikey"
import { KiroAuthError, requireOAuthCredential, type KiroCredentialManager } from "./auth"
import { API_PROVIDER_ID } from "./constants"
import { getProfileArn } from "./profile"

export type KiroSession = {
  authHeaders: () => Promise<Record<string, string>>
  profileArn: () => Promise<string>
  omitProfileArnInBody: boolean
}

/** Session for the device-flow logins, backed by the refreshing credential manager. */
export function createOAuthSession(credentials: KiroCredentialManager): KiroSession {
  let accessToken: Promise<string> | undefined
  const token = () => (accessToken ??= credentials.getAccessToken())

  return {
    async authHeaders() {
      return { authorization: `Bearer ${await token()}` }
    },
    async profileArn() {
      return getProfileArn(await token())
    },
    omitProfileArnInBody: false,
  }
}

export function createSession(
  credential: unknown,
  credentials?: KiroCredentialManager,
  dependencies: { readEnvKey?: () => string | undefined; mode?: "oauth" | "api" } = {},
): KiroSession {
  const mode = dependencies.mode ?? "oauth"
  const readEnvKey = dependencies.readEnvKey ?? readApiKeyFromEnv

  if (mode === "api") {
    if (isApiKeyCredential(credential)) return createApiKeySession(credential.key)
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
    return apiKeySessionFromEnv(envKey)
  }

  requireOAuthCredential(credential)
  if (!credentials) throw new KiroAuthError("Kiro OAuth credential manager is unavailable.")
  return createOAuthSession(credentials)
}

function apiKeySessionFromEnv(envKey: string): KiroSession {
  try {
    return createApiKeySession(envKey)
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "")
    throw new KiroAuthError(
      `The configured Kiro credential is unusable: ${detail}. ` +
        `Fix it or run \`opencode auth login --provider ${API_PROVIDER_ID}\`.`,
    )
  }
}
