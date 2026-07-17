import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { SSO_CACHE_DIR, TOKEN_FILES, EXPIRY_SKEW_MS } from "./constants"

export type KiroToken = {
  accessToken: string
  refreshToken: string
  expiresAt: string
  clientIdHash: string
  authMethod?: string
  provider?: string
  region?: string
}

type ClientRegistration = {
  clientId: string
  clientSecret: string
  expiresAt: string
}

export class KiroAuthError extends Error {}

/** Read the token cache that kiro-cli maintains. Throws if kiro-cli is not logged in. */
export async function readToken(): Promise<KiroToken & { file: string }> {
  for (const file of TOKEN_FILES) {
    const raw = await readFile(file, "utf8").catch(() => null)
    if (raw === null) continue
    const token = JSON.parse(raw) as KiroToken
    if (!token.accessToken || !token.refreshToken) {
      throw new KiroAuthError(`kiro-cli token cache at ${file} is missing accessToken/refreshToken.`)
    }
    return { ...token, file }
  }
  throw new KiroAuthError(
    `kiro-cli token not found (looked for ${TOKEN_FILES.join(", ")}). Run \`kiro-cli login\` (or \`kiro login\`) first.`,
  )
}

function isExpired(token: KiroToken): boolean {
  const expiresAt = Date.parse(token.expiresAt)
  if (Number.isNaN(expiresAt)) return true
  return expiresAt - EXPIRY_SKEW_MS <= Date.now()
}

/**
 * Return a valid access token, refreshing in place against AWS SSO-OIDC when needed.
 * The refreshed token is written back to kiro-cli's own cache so both tools stay in sync;
 * opencode never stores its own copy of the secret.
 */
export async function getValidAccessToken(): Promise<string> {
  const token = await readToken()
  if (!isExpired(token)) return token.accessToken
  const refreshed = await refresh(token)
  return refreshed.accessToken
}

async function refresh(token: KiroToken & { file: string }): Promise<KiroToken> {
  const region = token.region ?? "us-east-1"
  const client = await readClientRegistration(token.clientIdHash)

  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      grantType: "refresh_token",
      refreshToken: token.refreshToken,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new KiroAuthError(`Failed to refresh kiro-cli token (${res.status}). ${detail}`)
  }

  const body = (await res.json()) as {
    accessToken: string
    refreshToken?: string
    expiresIn: number
  }

  const { file, ...rest } = token
  const next: KiroToken = {
    ...rest,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken ?? token.refreshToken,
    expiresAt: new Date(Date.now() + body.expiresIn * 1000).toISOString(),
  }

  await writeFile(file, JSON.stringify(next, null, 2), "utf8").catch(() => {
    // Non-fatal: we still return a working token even if we cannot persist it.
  })
  return next
}

async function readClientRegistration(clientIdHash: string): Promise<ClientRegistration> {
  const file = join(SSO_CACHE_DIR, `${clientIdHash}.json`)
  const raw = await readFile(file, "utf8").catch(() => {
    throw new KiroAuthError(`Client registration not found at ${file}. Re-run kiro-cli login.`)
  })
  return JSON.parse(raw) as ClientRegistration
}
