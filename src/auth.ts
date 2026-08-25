import { Buffer } from "node:buffer"
import { EXPIRY_SKEW_MS } from "./constants"
import { redactKiroSecrets } from "./debug"

const BUILDER_ID_START_URL = "https://view.awsapps.com/start"
const BUILDER_ID_REGION = "us-east-1"

const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
]

const CLIENT_NAME = "opencode-kiro-auth"
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const REFRESH_STATE_PREFIX = "kiro-oauth-v1:"
const DEFAULT_DEVICE_EXPIRES_SECONDS = 600
const DEFAULT_POLL_INTERVAL_SECONDS = 5

export type KiroAuthMethod = "builder-id" | "idc"

export type OAuthCredential = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
}

type RefreshState = {
  version: 1
  refreshToken: string
  clientId: string
  clientSecret: string
  clientSecretExpiresAt?: number
  region: string
  startUrl: string
  authMethod: KiroAuthMethod
}

export type PendingDeviceAuthorization = {
  clientId: string
  clientSecret: string
  clientSecretExpiresAt?: number
  region: string
  startUrl: string
  authMethod: KiroAuthMethod
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  intervalSeconds: number
}

export type AuthDependencies = {
  fetch?: typeof globalThis.fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

type RegistrationResponse = {
  clientId?: string
  clientSecret?: string
  clientSecretExpiresAt?: number
}

type DeviceAuthorizationResponse = {
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  expiresIn?: number
  interval?: number
}

type TokenResponse = {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  error_description?: string
  message?: string
}

export type DeviceLogin =
  | { authMethod: "builder-id" }
  | { authMethod: "idc"; startUrl: string; region: string }

export class KiroAuthError extends Error {}

function nowOf(dependencies: AuthDependencies): number {
  return (dependencies.now ?? Date.now)()
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new KiroAuthError(`Kiro OAuth response is missing ${field}.`)
  }
  return value
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export function normalizeRegion(value: string): string {
  const region = value.trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    throw new KiroAuthError(`Invalid AWS region "${value}".`)
  }
  return region
}

export function normalizeStartUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new KiroAuthError("IAM Identity Center start URL must be a valid HTTPS URL.")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new KiroAuthError("IAM Identity Center start URL must be a valid HTTPS URL.")
  }
  return url.toString().replace(/\/$/, "")
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return ""
  const data = body as Record<string, unknown>
  for (const key of ["error", "error_description", "message"]) {
    const value = data[key]
    if (typeof value === "string" && value.length > 0) return redactKiroSecrets(value.slice(0, 300))
  }
  return ""
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  operation: string,
  fetcher: typeof globalThis.fetch,
): Promise<T> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (error) {
    const message = redactKiroSecrets(error instanceof Error ? error.message : String(error))
    throw new KiroAuthError(`${operation} could not reach AWS SSO OIDC: ${message}`)
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = errorDetail(data)
    throw new KiroAuthError(`${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return data as T
}

/**
 * Dynamically register this plugin as an AWS SSO OIDC public client and start
 * device authorization. The registration belongs to OpenCode, not kiro-cli.
 */
export async function beginDeviceAuthorization(
  login: DeviceLogin,
  dependencies: AuthDependencies = {},
): Promise<PendingDeviceAuthorization> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const authMethod = login.authMethod
  const region = authMethod === "builder-id" ? BUILDER_ID_REGION : normalizeRegion(login.region)
  const startUrl = authMethod === "builder-id" ? BUILDER_ID_START_URL : normalizeStartUrl(login.startUrl)
  const endpoint = `https://oidc.${region}.amazonaws.com`

  const registration = await postJson<RegistrationResponse>(
    `${endpoint}/client/register`,
    {
      clientName: CLIENT_NAME,
      clientType: "public",
      scopes: KIRO_SCOPES,
      grantTypes: [DEVICE_CODE_GRANT, "refresh_token"],
    },
    "Kiro client registration",
    fetcher,
  )
  const clientId = requiredString(registration.clientId, "clientId")
  const clientSecret = requiredString(registration.clientSecret, "clientSecret")

  const device = await postJson<DeviceAuthorizationResponse>(
    `${endpoint}/device_authorization`,
    { clientId, clientSecret, startUrl },
    "Kiro device authorization",
    fetcher,
  )

  return {
    clientId,
    clientSecret,
    clientSecretExpiresAt: registration.clientSecretExpiresAt,
    region,
    startUrl,
    authMethod,
    deviceCode: requiredString(device.deviceCode, "deviceCode"),
    userCode: requiredString(device.userCode, "userCode"),
    verificationUri: requiredString(device.verificationUri, "verificationUri"),
    verificationUriComplete:
      typeof device.verificationUriComplete === "string" && device.verificationUriComplete.length > 0
        ? device.verificationUriComplete
        : undefined,
    expiresAt:
      nowOf(dependencies) +
      positiveNumber(device.expiresIn, DEFAULT_DEVICE_EXPIRES_SECONDS) * 1000,
    intervalSeconds: positiveNumber(device.interval, DEFAULT_POLL_INTERVAL_SECONDS),
  }
}

function encodeRefreshState(state: RefreshState): string {
  return REFRESH_STATE_PREFIX + Buffer.from(JSON.stringify(state), "utf8").toString("base64url")
}

export function decodeRefreshState(value: string): RefreshState {
  if (value === "kiro-cli-managed") {
    throw new KiroAuthError(
      "This Kiro credential still points at kiro-cli storage. Run `opencode auth login --provider kiro` to migrate.",
    )
  }
  if (!value.startsWith(REFRESH_STATE_PREFIX)) {
    throw new KiroAuthError(
      "Kiro credential format is unsupported. Run `opencode auth login --provider kiro` to sign in again.",
    )
  }

  let parsed: unknown
  try {
    const encoded = value.slice(REFRESH_STATE_PREFIX.length)
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    throw new KiroAuthError(
      "Kiro credential is corrupt. Run `opencode auth login --provider kiro` to sign in again.",
    )
  }

  const state = parsed as Partial<RefreshState>
  const authMethod = state.authMethod
  if (
    state.version !== 1 ||
    (authMethod !== "builder-id" && authMethod !== "idc") ||
    typeof state.refreshToken !== "string" ||
    !state.refreshToken ||
    typeof state.clientId !== "string" ||
    !state.clientId ||
    typeof state.clientSecret !== "string" ||
    !state.clientSecret ||
    typeof state.region !== "string" ||
    typeof state.startUrl !== "string"
  ) {
    throw new KiroAuthError(
      "Kiro credential is incomplete. Run `opencode auth login --provider kiro` to sign in again.",
    )
  }
  return state as RefreshState
}

function credentialFromToken(
  token: TokenResponse,
  pending: PendingDeviceAuthorization,
  dependencies: AuthDependencies,
): OAuthCredential {
  const refreshToken = requiredString(token.refreshToken, "refreshToken")
  return {
    type: "oauth",
    access: requiredString(token.accessToken, "accessToken"),
    refresh: encodeRefreshState({
      version: 1,
      refreshToken,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      clientSecretExpiresAt: pending.clientSecretExpiresAt,
      region: pending.region,
      startUrl: pending.startUrl,
      authMethod: pending.authMethod,
    }),
    expires: nowOf(dependencies) + positiveNumber(token.expiresIn, 3600) * 1000,
  }
}

/** Poll AWS SSO OIDC until the user approves the device code or it expires. */
export async function completeDeviceAuthorization(
  pending: PendingDeviceAuthorization,
  dependencies: AuthDependencies = {},
): Promise<OAuthCredential> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const wait = dependencies.sleep ?? sleep
  const endpoint = `https://oidc.${pending.region}.amazonaws.com/token`
  let interval = Math.max(1, pending.intervalSeconds) * 1000

  while (nowOf(dependencies) < pending.expiresAt) {
    await wait(interval)
    if (nowOf(dependencies) >= pending.expiresAt) break

    let response: Response
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: pending.clientId,
          clientSecret: pending.clientSecret,
          deviceCode: pending.deviceCode,
          grantType: DEVICE_CODE_GRANT,
        }),
      })
    } catch {
      continue
    }

    const data = (await response.json().catch(() => ({}))) as TokenResponse
    if (response.ok && data.accessToken && data.refreshToken) {
      return credentialFromToken(data, pending, dependencies)
    }
    if (data.error === "authorization_pending") continue
    if (data.error === "slow_down") {
      interval += 5000
      continue
    }
    if (response.status === 429 || response.status >= 500) continue

    const detail = errorDetail(data)
    throw new KiroAuthError(
      `Kiro device authorization failed (${response.status})${detail ? `: ${detail}` : ""}`,
    )
  }

  throw new KiroAuthError("Kiro device authorization timed out. Run `opencode auth login --provider kiro` again.")
}

export function requireOAuthCredential(value: unknown): OAuthCredential {
  if (!value || typeof value !== "object") {
    throw new KiroAuthError("Kiro is not signed in. Run `opencode auth login --provider kiro`.")
  }
  const auth = value as Partial<OAuthCredential>
  if (
    auth.type !== "oauth" ||
    typeof auth.access !== "string" ||
    typeof auth.refresh !== "string" ||
    typeof auth.expires !== "number"
  ) {
    throw new KiroAuthError("Kiro is not signed in with OAuth. Run `opencode auth login --provider kiro`.")
  }
  return auth as OAuthCredential
}

export async function refreshOAuthCredential(
  credential: OAuthCredential,
  dependencies: AuthDependencies = {},
): Promise<OAuthCredential> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const state = decodeRefreshState(credential.refresh)
  if (
    typeof state.clientSecretExpiresAt === "number" &&
    state.clientSecretExpiresAt * 1000 <= nowOf(dependencies) + EXPIRY_SKEW_MS
  ) {
    throw new KiroAuthError(
      "Kiro OAuth client registration expired. Run `opencode auth login --provider kiro` to sign in again.",
    )
  }

  const token = await postJson<TokenResponse>(
    `https://oidc.${normalizeRegion(state.region)}.amazonaws.com/token`,
    {
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      refreshToken: state.refreshToken,
      grantType: "refresh_token",
    },
    "Kiro token refresh",
    fetcher,
  )
  const nextRefreshToken =
    typeof token.refreshToken === "string" && token.refreshToken.length > 0
      ? token.refreshToken
      : state.refreshToken

  return {
    type: "oauth",
    access: requiredString(token.accessToken, "accessToken"),
    refresh: encodeRefreshState({ ...state, refreshToken: nextRefreshToken }),
    expires: nowOf(dependencies) + positiveNumber(token.expiresIn, 3600) * 1000,
  }
}

type CredentialReader = () => Promise<unknown>
type CredentialWriter = (credential: OAuthCredential) => Promise<void>

export class KiroCredentialManager {
  private refreshInFlight: Promise<OAuthCredential> | undefined

  constructor(
    private readonly read: CredentialReader,
    private readonly write: CredentialWriter,
    private readonly dependencies: AuthDependencies = {},
  ) {}

  async getAccessToken(): Promise<string> {
    const credential = requireOAuthCredential(await this.read())
    if (
      credential.access.length > 0 &&
      credential.expires > nowOf(this.dependencies) + EXPIRY_SKEW_MS
    ) {
      return credential.access
    }

    if (!this.refreshInFlight) {
      this.refreshInFlight = refreshOAuthCredential(credential, this.dependencies)
        .then(async (next) => {
          await this.write(next)
          return next
        })
        .finally(() => {
          this.refreshInFlight = undefined
        })
    }
    return (await this.refreshInFlight).access
  }
}
