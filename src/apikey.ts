import { getProfile, type KiroClientDependencies } from "./client"
import { KIRO_MANAGEMENT_ENDPOINTS } from "./constants"
import { redactKiroSecrets } from "./debug"

export const API_KEY_PREFIX = "ksk_"

export const API_KEY_ENV_VAR = "KIRO_API_KEY"

export type ApiKeyCredential = {
  type: "api"
  key: string
}

export class KiroApiKeyError extends Error {}

export function isApiKeyCredential(value: unknown): value is ApiKeyCredential {
  if (!value || typeof value !== "object") return false
  const credential = value as Partial<ApiKeyCredential>
  return credential.type === "api" && typeof credential.key === "string" && credential.key.length > 0
}

export function normalizeApiKey(value: string): string {
  const key = value.trim()
  if (!key) {
    throw new KiroApiKeyError("Kiro credential is empty.")
  }
  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new KiroApiKeyError("Kiro credential is invalid.")
  }
  return key
}

export function readApiKeyFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[API_KEY_ENV_VAR]?.trim()
  return raw ? raw : undefined
}

export async function fetchApiKeyProfileArn(
  key: string,
  dependencies: KiroClientDependencies = {},
): Promise<string> {
  const failures: string[] = []
  for (const endpoint of KIRO_MANAGEMENT_ENDPOINTS) {
    const region = new URL(endpoint).host
    let response: Response
    try {
      response = await getProfile(key, endpoint, dependencies)
    } catch (error) {
      failures.push(`${region}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!response.ok) {
      failures.push(`${region}: HTTP ${response.status}`)
      continue
    }

    // An ok response can still be unusable; fall through to the next region.
    const data = (await response.json().catch(() => null)) as { profile?: { arn?: unknown } } | null
    const arn = data?.profile?.arn
    if (typeof arn === "string" && arn.length > 0) return arn
    failures.push(`${region}: ${data === null ? "non-JSON response" : "response has no profile ARN"}`)
  }

  // Region hosts and failure reasons are safe to surface; the credential itself never is.
  throw new KiroApiKeyError(
    "Kiro could not use the configured credential. Verify it is active and try again. " +
      `(${redactKiroSecrets(failures.join("; "))})`,
  )
}
