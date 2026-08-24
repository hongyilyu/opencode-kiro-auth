import { describe, expect, it } from "bun:test"
import {
  fetchApiKeyProfileArn,
  isApiKeyCredential,
  normalizeApiKey,
  readApiKeyFromEnv,
} from "../src/apikey"
import { KiroCredentialManager, type OAuthCredential } from "../src/auth"
import { createApiKeySession, createSession } from "../src/session"

const API_KEY = "ksk_offlinetestkey"
const REAL_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/TESTPROFILE"

// Shape-only stand-ins for the split tests: both throw before ever being used for real work.
const oauthShapedCredential: OAuthCredential = { type: "oauth", access: "access-1", refresh: "refresh-state", expires: 1 }
const unusedManager = new KiroCredentialManager(
  async () => oauthShapedCredential,
  async () => {},
)

/**
 * Management-endpoint mock that rejects non-API-key auth, 403s us-east-1, and resolves
 * eu-central-1 — exercising the region fallthrough. Each call site gets its own fetch
 * instance because the profileArn cache is keyed per fetch function (WeakMap).
 */
function regionFallthroughFetch() {
  const calls: string[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push(String(url))
    const headers = init.headers as Record<string, string>
    if (headers.tokentype !== "API_KEY") return new Response("{}", { status: 400 })
    if (String(url).includes("us-east-1")) return new Response("{}", { status: 403 })
    return new Response(JSON.stringify({ profile: { arn: REAL_ARN } }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe("api key validation", () => {
  it("api: recognizes stored api credential", () => {
    expect(isApiKeyCredential({ type: "api", key: API_KEY })).toBe(true)
    expect(isApiKeyCredential({ type: "api", key: "" })).toBe(false)
    expect(isApiKeyCredential(oauthShapedCredential)).toBe(false)
  })

  it("api: rejects malformed key without format guidance", () => {
    let badPrefix = ""
    try {
      normalizeApiKey("sk-not-a-kiro-key")
    } catch (error) {
      badPrefix = error instanceof Error ? error.message : String(error)
    }
    expect(badPrefix).toContain("invalid")
    expect(badPrefix).not.toContain("ksk_")
  })

  it("api: trims a valid key", () => {
    expect(normalizeApiKey(`  ${API_KEY}  `)).toBe(API_KEY)
  })

  it("api: reads KIRO_API_KEY from env", () => {
    expect(readApiKeyFromEnv({ KIRO_API_KEY: ` ${API_KEY} ` })).toBe(API_KEY)
    expect(readApiKeyFromEnv({ KIRO_API_KEY: "   " })).toBeUndefined()
    expect(readApiKeyFromEnv({})).toBeUndefined()
  })
})

describe("api key session", () => {
  it("api: sends bearer + tokentype header", async () => {
    const apiHeaders = await createApiKeySession(API_KEY).authHeaders()
    expect(apiHeaders.authorization).toBe(`Bearer ${API_KEY}`)
    expect(apiHeaders.tokentype).toBe("API_KEY")
  })

  it("api: omits profileArn in chat body", async () => {
    expect(await createApiKeySession(API_KEY).chatProfileArn()).toBeUndefined()
  })
})

describe("api key profileArn resolution", () => {
  it("api: falls through regions to resolve profileArn", async () => {
    const { calls, fetcher } = regionFallthroughFetch()
    expect(await fetchApiKeyProfileArn(API_KEY, { fetch: fetcher })).toBe(REAL_ARN)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain("eu-central-1")
  })

  it("api: caches resolved profileArn", async () => {
    const { calls, fetcher } = regionFallthroughFetch()
    const cached = createApiKeySession("ksk_cachetestkey", { fetch: fetcher })
    const cachedArns = [await cached.mcpProfileArn(), await cached.mcpProfileArn()]
    // One resolution = two region attempts; the second mcpProfileArn() hits the cache.
    expect(calls).toHaveLength(2)
    for (const arn of cachedArns) expect(arn).toBe(REAL_ARN)
  })

  it("api: retries profileArn after a failure", async () => {
    let outage = true
    const flakyFetch = (async () =>
      outage
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ profile: { arn: REAL_ARN } }), { status: 200 })) as unknown as typeof fetch
    const flaky = createApiKeySession("ksk_flakytestkey", { fetch: flakyFetch })
    const firstFailed = await flaky.mcpProfileArn().then(
      () => false,
      () => true,
    )
    outage = false
    let recovered = false
    try {
      recovered = (await flaky.mcpProfileArn()) === REAL_ARN
    } catch {
      recovered = false
    }
    expect(firstFailed).toBe(true)
    expect(recovered).toBe(true)
  })

  it("api: cache shared across sessions", async () => {
    const { calls, fetcher } = regionFallthroughFetch()
    await createApiKeySession("ksk_sharedtestkey", { fetch: fetcher }).mcpProfileArn()
    await createApiKeySession("ksk_sharedtestkey", { fetch: fetcher }).mcpProfileArn()
    expect(calls).toHaveLength(2)
  })

  it("api: cache isolated by fetch implementation", async () => {
    // Resolve the key once under one fetch instance...
    const shared = regionFallthroughFetch()
    await createApiKeySession("ksk_isolationtestkey", { fetch: shared.fetcher }).mcpProfileArn()
    // ...then prove a different fetch instance does not see that cache entry.
    let isolatedCalls = 0
    const isolatedFetch = (async () => {
      isolatedCalls++
      return new Response(JSON.stringify({ profile: { arn: `${REAL_ARN}-ISOLATED` } }), { status: 200 })
    }) as unknown as typeof fetch
    const isolatedArn = await createApiKeySession("ksk_isolationtestkey", { fetch: isolatedFetch }).mcpProfileArn()
    expect(isolatedCalls).toBe(1)
    expect(isolatedArn).toBe(`${REAL_ARN}-ISOLATED`)
  })

  it("api: profile cache is bounded", async () => {
    let evictionCalls = 0
    const evictionFetch = (async () => {
      evictionCalls++
      return new Response(JSON.stringify({ profile: { arn: REAL_ARN } }), { status: 200 })
    }) as unknown as typeof fetch
    for (let i = 0; i < 9; i++) {
      await createApiKeySession(`ksk_eviction${i}`, { fetch: evictionFetch }).mcpProfileArn()
    }
    // The 9th insert evicts key 0 (cache limit 8), so resolving it again refetches.
    await createApiKeySession("ksk_eviction0", { fetch: evictionFetch }).mcpProfileArn()
    expect(evictionCalls).toBe(10)
  })

  it("api: reports a rejected key clearly", async () => {
    let allFailedMessage = ""
    try {
      await fetchApiKeyProfileArn(API_KEY, {
        fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch,
      })
    } catch (error) {
      allFailedMessage = error instanceof Error ? error.message : String(error)
    }
    expect(allFailedMessage).toContain("could not use the configured credential")
    expect(allFailedMessage).not.toContain("app.kiro.dev")
    expect(allFailedMessage).not.toContain(API_KEY)
  })
})

describe("session mode splitting", () => {
  it("api: env var used only as fallback", async () => {
    const envOnly = createSession(undefined, undefined, { mode: "api", readEnvKey: () => API_KEY })
    expect((await envOnly.authHeaders()).tokentype).toBe("API_KEY")
    const stored = createSession({ type: "api", key: "ksk_storedkey" }, undefined, {
      mode: "api",
      readEnvKey: () => API_KEY,
    })
    expect((await stored.authHeaders()).authorization).toBe("Bearer ksk_storedkey")
  })

  it("api: no credential still errors", () => {
    let noCredentialMessage = ""
    try {
      createSession(undefined, undefined, { mode: "api", readEnvKey: () => undefined })
    } catch (error) {
      noCredentialMessage = error instanceof Error ? error.message : String(error)
    }
    expect(noCredentialMessage).toContain("auth login")
  })

  it("api: reports an unusable configured credential generically", () => {
    let badEnvMessage = ""
    try {
      createSession(undefined, undefined, { mode: "api", readEnvKey: () => "not-a-kiro-key" })
    } catch (error) {
      badEnvMessage = error instanceof Error ? error.message : String(error)
    }
    expect(badEnvMessage).toContain("configured Kiro credential is unusable")
    expect(badEnvMessage).not.toContain("KIRO_API_KEY")
    expect(badEnvMessage).not.toContain("ksk_")
  })

  it("split: api provider rejects an oauth credential", () => {
    let apiModeRejects = ""
    try {
      createSession(oauthShapedCredential, unusedManager, { mode: "api", readEnvKey: () => undefined })
    } catch (error) {
      apiModeRejects = error instanceof Error ? error.message : String(error)
    }
    expect(apiModeRejects.includes("kiro-api") || apiModeRejects.includes("KIRO_API_KEY")).toBe(true)
  })

  it("split: api provider reads env key", async () => {
    const session = createSession(undefined, unusedManager, { mode: "api", readEnvKey: () => API_KEY })
    expect((await session.authHeaders()).tokentype).toBe("API_KEY")
  })

  it("split: oauth provider rejects an api credential", () => {
    let oauthModeRejectsApi = ""
    try {
      createSession({ type: "api", key: API_KEY }, unusedManager, { mode: "oauth" })
    } catch (error) {
      oauthModeRejectsApi = error instanceof Error ? error.message : String(error)
    }
    expect(oauthModeRejectsApi).toContain("OAuth")
    expect(oauthModeRejectsApi).toContain("provider kiro")
  })
})
