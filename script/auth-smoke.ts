import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroCredentialManager,
  type OAuthCredential,
} from "../src/auth"

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
    }) as typeof fetch,
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

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  auth: ${name}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
