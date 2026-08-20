import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroCredentialManager,
  type OAuthCredential,
} from "../src/auth"
import {
  createApiKeySession,
  fetchApiKeyProfileArn,
  isApiKeyCredential,
  normalizeApiKey,
  readApiKeyFromEnv,
} from "../src/apikey"
import { createSession } from "../src/session"
import { getProfileArn } from "../src/profile"
import { redactKiroSecrets } from "../src/debug"

const checks: Array<[string, boolean]> = []
const calls: Array<{ url: string; body: any }> = []
const responses = [
  {
    clientId: "client-1",
    clientSecret: "secret-1",
    clientSecretExpiresAt: 9_999_999_999,
  },
  {
    deviceCode: "device-1",
    userCode: "ABCD-EFGH",
    verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
    verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
    expiresIn: 600,
    interval: 2,
  },
  { error: "authorization_pending" },
  { error: "slow_down" },
  {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 3600,
  },
]
let responseIndex = 0
const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({
    url: String(input),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  })
  const body = responses[responseIndex++]
  const pending = body && "error" in body
  return new Response(JSON.stringify(body), {
    status: pending ? 400 : 200,
    headers: { "content-type": "application/json" },
  })
}

const pending = await beginDeviceAuthorization(
  { authMethod: "builder-id" },
  { fetch: mockFetch as typeof fetch, now: () => 1_000 },
)
checks.push([
  "registers independent OAuth client",
  calls[0]?.url === "https://oidc.us-east-1.amazonaws.com/client/register" &&
    calls[0]?.body?.clientName === "opencode-kiro-auth" &&
    calls[0]?.body?.clientType === "public",
])
checks.push([
  "starts Builder ID device flow",
  calls[1]?.url === "https://oidc.us-east-1.amazonaws.com/device_authorization" &&
    calls[1]?.body?.startUrl === "https://view.awsapps.com/start",
])

const waits: number[] = []
const credential = await completeDeviceAuthorization(pending, {
  fetch: mockFetch as typeof fetch,
  now: () => 1_000,
  sleep: async (milliseconds) => {
    waits.push(milliseconds)
  },
})
const state = decodeRefreshState(credential.refresh)
checks.push([
  "polls pending and slow-down responses",
  waits.join(",") === "2000,2000,7000" && calls.length === 5,
])
checks.push([
  "stores self-contained refresh state",
  credential.access === "access-1" &&
    state.refreshToken === "refresh-1" &&
    state.clientId === "client-1" &&
    state.clientSecret === "secret-1" &&
    state.authMethod === "builder-id",
])

let refreshCalls = 0
let persisted: OAuthCredential | undefined
const expired = { ...credential, access: "", expires: 0 }
const manager = new KiroCredentialManager(
  async () => expired,
  async (next) => {
    persisted = next
  },
  {
    now: () => 2_000,
    fetch: (async () => {
      refreshCalls++
      return new Response(JSON.stringify({ accessToken: "access-2", expiresIn: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch,
  },
)
const refreshed = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
checks.push([
  "deduplicates concurrent refresh",
  refreshCalls === 1 && refreshed.every((token) => token === "access-2"),
])
checks.push([
  "persists refreshed credential",
  persisted?.access === "access-2" &&
    decodeRefreshState(persisted.refresh).refreshToken === "refresh-1",
])

let migrationMessage = ""
try {
  decodeRefreshState("kiro-cli-managed")
} catch (error) {
  migrationMessage = error instanceof Error ? error.message : String(error)
}
checks.push([
  "rejects legacy kiro-cli sentinel",
  migrationMessage.includes("opencode auth login --provider kiro"),
])

const API_KEY = "ksk_offlinetestkey"
const REAL_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/TESTPROFILE"

checks.push([
  "api: recognizes stored api credential",
  isApiKeyCredential({ type: "api", key: API_KEY }) &&
    !isApiKeyCredential({ type: "api", key: "" }) &&
    !isApiKeyCredential(credential),
])

let badPrefix = ""
try {
  normalizeApiKey("sk-not-a-kiro-key")
} catch (error) {
  badPrefix = error instanceof Error ? error.message : String(error)
}
checks.push(["api: rejects non-ksk key", badPrefix.includes("ksk_")])
checks.push(["api: trims a valid key", normalizeApiKey(`  ${API_KEY}  `) === API_KEY])

checks.push([
  "api: reads KIRO_API_KEY from env",
  readApiKeyFromEnv({ KIRO_API_KEY: ` ${API_KEY} ` }) === API_KEY &&
    readApiKeyFromEnv({ KIRO_API_KEY: "   " }) === undefined &&
    readApiKeyFromEnv({}) === undefined,
])

const apiSession = createApiKeySession(API_KEY)
const apiHeaders = await apiSession.authHeaders()
checks.push([
  "api: sends bearer + tokentype header",
  apiHeaders.authorization === `Bearer ${API_KEY}` && apiHeaders.tokentype === "API_KEY",
])
checks.push(["api: omits profileArn in chat body", apiSession.omitProfileArnInBody === true])

const oauthSession = createSession(credential, manager)
const oauthHeaders = await oauthSession.authHeaders()
checks.push([
  "oauth: no tokentype header, keeps profileArn",
  oauthHeaders.tokentype === undefined &&
    oauthHeaders.authorization === "Bearer access-2" &&
    oauthSession.omitProfileArnInBody === false,
])

let profileCalls: string[] = []
const profileFetch = (async (url: string, init: RequestInit) => {
  profileCalls.push(String(url))
  const headers = init.headers as Record<string, string>
  if (headers.tokentype !== "API_KEY") return new Response("{}", { status: 400 })
  if (String(url).includes("us-east-1")) return new Response("{}", { status: 403 })
  return new Response(JSON.stringify({ profile: { arn: REAL_ARN } }), { status: 200 })
}) as unknown as typeof fetch

checks.push([
  "api: falls through regions to resolve profileArn",
  (await fetchApiKeyProfileArn(API_KEY, { fetch: profileFetch })) === REAL_ARN &&
    profileCalls.length === 2 &&
    profileCalls[1].includes("eu-central-1"),
])

const cachedKey = "ksk_cachetestkey"
profileCalls = []
const cached = createApiKeySession(cachedKey, { fetch: profileFetch })
const cachedArns = [await cached.profileArn(), await cached.profileArn()]
checks.push([
  "api: caches resolved profileArn",
  profileCalls.length === 2 && cachedArns.every((arn) => arn === REAL_ARN),
])

let outage = true
const flakyFetch = (async () =>
    outage
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ profile: { arn: REAL_ARN } }), {
          status: 200,
        })) as unknown as typeof fetch
const flaky = createApiKeySession("ksk_flakytestkey", { fetch: flakyFetch })
const firstFailed = await flaky.profileArn().then(
  () => false,
  () => true,
)
outage = false
let recovered = false
try {
  recovered = (await flaky.profileArn()) === REAL_ARN
} catch {
  recovered = false
}
checks.push([
  "api: retries profileArn after a failure",
  firstFailed && recovered,
])

profileCalls = []
await createApiKeySession("ksk_sharedtestkey", { fetch: profileFetch }).profileArn()
await createApiKeySession("ksk_sharedtestkey", { fetch: profileFetch }).profileArn()
checks.push(["api: cache shared across sessions", profileCalls.length === 2])

let isolatedCalls = 0
const isolatedFetch = (async () => {
  isolatedCalls++
  return new Response(JSON.stringify({ profile: { arn: `${REAL_ARN}-ISOLATED` } }), { status: 200 })
}) as unknown as typeof fetch
const isolatedArn = await createApiKeySession("ksk_sharedtestkey", { fetch: isolatedFetch }).profileArn()
checks.push([
  "api: cache isolated by fetch implementation",
  isolatedCalls === 1 && isolatedArn === `${REAL_ARN}-ISOLATED`,
])

let evictionCalls = 0
const evictionFetch = (async () => {
  evictionCalls++
  return new Response(JSON.stringify({ profile: { arn: REAL_ARN } }), { status: 200 })
}) as unknown as typeof fetch
for (let i = 0; i < 9; i++) {
  await createApiKeySession(`ksk_eviction${i}`, { fetch: evictionFetch }).profileArn()
}
await createApiKeySession("ksk_eviction0", { fetch: evictionFetch }).profileArn()
checks.push(["api: profile cache is bounded", evictionCalls === 10])

let allFailedMessage = ""
try {
  await fetchApiKeyProfileArn(API_KEY, {
    fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch,
  })
} catch (error) {
  allFailedMessage = error instanceof Error ? error.message : String(error)
}
checks.push([
  "api: reports a rejected key clearly",
  allFailedMessage.includes("app.kiro.dev") && !allFailedMessage.includes(API_KEY),
])

const envOnly = createSession(undefined, undefined, { mode: "api", readEnvKey: () => API_KEY })
checks.push([
  "api: env var used only as fallback",
  (await envOnly.authHeaders()).tokentype === "API_KEY" &&
    (
      await createSession({ type: "api", key: "ksk_storedkey" }, undefined, {
        mode: "api",
        readEnvKey: () => API_KEY,
      }).authHeaders()
    ).authorization === "Bearer ksk_storedkey",
])

let noCredentialMessage = ""
try {
  createSession(undefined, undefined, { mode: "api", readEnvKey: () => undefined })
} catch (error) {
  noCredentialMessage = error instanceof Error ? error.message : String(error)
}
checks.push(["api: no credential still errors", noCredentialMessage.includes("auth login")])

let badEnvMessage = ""
try {
  createSession(undefined, undefined, { mode: "api", readEnvKey: () => "not-a-kiro-key" })
} catch (error) {
  badEnvMessage = error instanceof Error ? error.message : String(error)
}
checks.push([
  "api: explains an unusable env key",
  badEnvMessage.includes("KIRO_API_KEY") && badEnvMessage.includes("ksk_"),
])

let apiModeRejects = ""
try {
  createSession(credential, manager, { mode: "api", readEnvKey: () => undefined })
} catch (error) {
  apiModeRejects = error instanceof Error ? error.message : String(error)
}
checks.push([
  "split: api provider rejects an oauth credential",
  apiModeRejects.includes("kiro-api") || apiModeRejects.includes("KIRO_API_KEY"),
])

checks.push([
  "split: api provider reads env key",
  (await createSession(undefined, manager, { mode: "api", readEnvKey: () => API_KEY }).authHeaders())
    .tokentype === "API_KEY",
])

let oauthModeRejectsApi = ""
try {
  createSession({ type: "api", key: API_KEY }, manager, { mode: "oauth" })
} catch (error) {
  oauthModeRejectsApi = error instanceof Error ? error.message : String(error)
}
checks.push([
  "split: oauth provider rejects an api credential",
  oauthModeRejectsApi.includes("OAuth") && oauthModeRejectsApi.includes("provider kiro"),
])

let oauthProfileCalls = 0
const oauthProfileFetch = (async (_url: string, init: RequestInit) => {
  oauthProfileCalls++
  const authorization = (init.headers as Record<string, string>).authorization
  const suffix = authorization.endsWith("oauth-token-a") ? "A" : "B"
  return new Response(JSON.stringify({ profiles: [{ arn: `${REAL_ARN}-${suffix}` }] }), { status: 200 })
}) as unknown as typeof fetch
const oauthArns = [
  await getProfileArn("oauth-token-a", { fetch: oauthProfileFetch }),
  await getProfileArn("oauth-token-b", { fetch: oauthProfileFetch }),
  await getProfileArn("oauth-token-a", { fetch: oauthProfileFetch }),
]
checks.push([
  "oauth: profile cache is token-specific",
  oauthProfileCalls === 2 && oauthArns.join(",") === `${REAL_ARN}-A,${REAL_ARN}-B,${REAL_ARN}-A`,
])

checks.push([
  "secrets: redacts api keys and bearer tokens",
  redactKiroSecrets(`failed for ${API_KEY} with Bearer oauth-secret-123; bearer token was invalid`) ===
    "failed for ksk_<redacted> with Bearer <redacted>; bearer token was invalid",
])

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  auth: ${name}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
