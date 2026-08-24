import { getProfile } from "./client"

export const API_KEY_PREFIX = "ksk_"

export const API_KEY_ENV_VAR = "KIRO_API_KEY"

export type ApiKeyCredential = {
  type: "api"
  key: string
}

export class KiroApiKeyError extends Error {}

export type ApiKeyDependencies = {
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
  dependencies: ApiKeyDependencies = {},
): Promise<string> {
  try {
    const response = await getProfile(key, dependencies)
    if (response.ok) {
      const data = (await response.json().catch(() => null)) as { profile?: { arn?: unknown } } | null
      const arn = data?.profile?.arn
      if (typeof arn === "string" && arn.length > 0) return arn
    }
  } catch {
    // The public error deliberately does not expose endpoint or credential details.
  }

  throw new KiroApiKeyError("Kiro could not use the configured credential. Verify it is active and try again.")
}
