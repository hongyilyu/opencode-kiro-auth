import { describe, expect, it } from "bun:test"
import { fetchApiKeyProfileArn, KiroApiKeyError } from "../src/apikey"
import { KIRO_PROFILE_ARN_PLACEHOLDER } from "../src/constants"
import { getApiKeyProfileArn, getProfileArn } from "../src/profile"
import { createApiKeySession } from "../src/session"
import { jsonResponse, messageOf, rejectionOf, scriptedFetch } from "./support/http-fixtures"

// Loader policy for the two profile-ARN memos in src/profile.ts: what is cached, what is retried,
// and how the cache is scoped. Eviction mechanics are memo.test.ts's concern, not proven here.

const API_KEY = "ksk_offlinetestkey"
const REAL_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/TESTPROFILE"

describe("oauth profile resolution", () => {
  /** The answer a healthy ListAvailableProfiles gives; repeated as the tail of every script below. */
  const realProfile = () => jsonResponse({ profiles: [{ arn: REAL_ARN }] })

  it("oauth: profile cache is token-specific", async () => {
    // Distinct fetch instance: the profile cache is keyed per fetch function (WeakMap),
    // so a fresh instance guarantees isolation from other tests.
    const profile = scriptedFetch(
      (call) => {
        const authorization = new Headers(call.init?.headers).get("authorization") ?? ""
        const suffix = authorization.endsWith("oauth-token-a") ? "A" : "B"
        return jsonResponse({ profiles: [{ arn: `${REAL_ARN}-${suffix}` }] })
      },
      { onExhausted: "repeat-last" },
    )
    const oauthArns = [
      await getProfileArn("oauth-token-a", { fetch: profile.fetch }),
      await getProfileArn("oauth-token-b", { fetch: profile.fetch }),
      await getProfileArn("oauth-token-a", { fetch: profile.fetch }),
    ]
    expect(profile.calls).toHaveLength(2)
    expect(oauthArns.join(",")).toBe(`${REAL_ARN}-A,${REAL_ARN}-B,${REAL_ARN}-A`)
  })

  it("a 5xx answer degrades this call to the placeholder without caching it", async () => {
    const { fetch, calls } = scriptedFetch(new Response("{}", { status: 503 }), realProfile, { onExhausted: "repeat-last" })

    expect(await getProfileArn("oauth-5xx", { fetch })).toBe(KIRO_PROFILE_ARN_PLACEHOLDER)
    expect(await getProfileArn("oauth-5xx", { fetch })).toBe(REAL_ARN)
    expect(calls).toHaveLength(2)
  })

  it("a thrown fetch degrades this call to the placeholder without caching it", async () => {
    const { fetch, calls } = scriptedFetch(new TypeError("network down"), realProfile, { onExhausted: "repeat-last" })

    expect(await getProfileArn("oauth-thrown", { fetch })).toBe(KIRO_PROFILE_ARN_PLACEHOLDER)
    expect(await getProfileArn("oauth-thrown", { fetch })).toBe(REAL_ARN)
    expect(calls).toHaveLength(2)
  })

  it("a 4xx answer caches the placeholder", async () => {
    const { fetch, calls } = scriptedFetch(
      jsonResponse({ message: "unauthorized" }, { status: 403 }),
      realProfile,
      { onExhausted: "repeat-last" },
    )

    expect(await getProfileArn("oauth-4xx", { fetch })).toBe(KIRO_PROFILE_ARN_PLACEHOLDER)
    expect(await getProfileArn("oauth-4xx", { fetch })).toBe(KIRO_PROFILE_ARN_PLACEHOLDER)
    expect(calls).toHaveLength(1)
  })

  it("a 2xx answer without profiles caches the placeholder", async () => {
    const { fetch, calls } = scriptedFetch(jsonResponse({ profiles: [] }), realProfile, { onExhausted: "repeat-last" })

    expect(await getProfileArn("oauth-empty", { fetch })).toBe(KIRO_PROFILE_ARN_PLACEHOLDER)
    expect(await getProfileArn("oauth-empty", { fetch })).toBe(KIRO_PROFILE_ARN_PLACEHOLDER)
    expect(calls).toHaveLength(1)
  })
})

describe("api key profileArn resolution", () => {
  /**
   * Management-endpoint mock that rejects non-API-key auth, 403s us-east-1, and resolves
   * eu-central-1 — exercising the region fallthrough. Each call site gets its own fetch
   * instance because the profileArn cache is keyed per fetch function (WeakMap).
   */
  function regionFallthroughFetch() {
    return scriptedFetch(
      (call) => {
        if (new Headers(call.init?.headers).get("tokentype") !== "API_KEY") return new Response("{}", { status: 400 })
        if (call.url.includes("us-east-1")) return new Response("{}", { status: 403 })
        return jsonResponse({ profile: { arn: REAL_ARN } })
      },
      { onExhausted: "repeat-last" },
    )
  }

  it("api: falls through regions to resolve profileArn", async () => {
    const { calls, fetch } = regionFallthroughFetch()
    expect(await fetchApiKeyProfileArn(API_KEY, { fetch })).toBe(REAL_ARN)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toContain("eu-central-1")
  })

  it("api: caches resolved profileArn", async () => {
    const { calls, fetch } = regionFallthroughFetch()
    const cached = createApiKeySession("ksk_cachetestkey", { fetch })
    const cachedArns = [await cached.mcpProfileArn(), await cached.mcpProfileArn()]
    // One resolution = two region attempts; the second mcpProfileArn() hits the cache.
    expect(calls).toHaveLength(2)
    for (const arn of cachedArns) expect(arn).toBe(REAL_ARN)
  })

  it("a resolved ARN is cached per key", async () => {
    const ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/APIKEY"
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ profile: { arn: ARN } }), { onExhausted: "repeat-last" })

    expect(await getApiKeyProfileArn("ksk_cached", { fetch })).toBe(ARN)
    expect(await getApiKeyProfileArn("ksk_cached", { fetch })).toBe(ARN)
    expect(calls).toHaveLength(1)
  })

  it("api: retries profileArn after a failure", async () => {
    let outage = true
    const upstream = scriptedFetch(
      () => (outage ? new Response("{}", { status: 503 }) : jsonResponse({ profile: { arn: REAL_ARN } })),
      { onExhausted: "repeat-last" },
    )
    const flaky = createApiKeySession("ksk_flakytestkey", { fetch: upstream.fetch })
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

  it("a failed lookup rejects with KiroApiKeyError and is not cached", async () => {
    const { fetch, calls } = scriptedFetch(
      new Response("{}", { status: 500 }),
      new Response("{}", { status: 500 }),
      () => new Response("{}", { status: 200 }),
      { onExhausted: "repeat-last" },
    )

    const first = await rejectionOf(getApiKeyProfileArn("ksk_cachepolicy", { fetch }))
    expect(first).toBeInstanceOf(KiroApiKeyError)
    expect(messageOf(first)).not.toContain("ksk_cachepolicy")
    // Both management regions were tried; a retry fetches again instead of replaying the rejection.
    expect(calls).toHaveLength(2)
    await getApiKeyProfileArn("ksk_cachepolicy", { fetch }).catch(() => undefined)
    expect(calls.length).toBeGreaterThan(2)
  })

  it("api: cache shared across sessions", async () => {
    const { calls, fetch } = regionFallthroughFetch()
    await createApiKeySession("ksk_sharedtestkey", { fetch }).mcpProfileArn()
    await createApiKeySession("ksk_sharedtestkey", { fetch }).mcpProfileArn()
    expect(calls).toHaveLength(2)
  })

  it("api: cache isolated by fetch implementation", async () => {
    // Resolve the key once under one fetch instance...
    const shared = regionFallthroughFetch()
    await createApiKeySession("ksk_isolationtestkey", { fetch: shared.fetch }).mcpProfileArn()
    // ...then prove a different fetch instance does not see that cache entry.
    const isolated = scriptedFetch(() => jsonResponse({ profile: { arn: `${REAL_ARN}-ISOLATED` } }), {
      onExhausted: "repeat-last",
    })
    const isolatedArn = await createApiKeySession("ksk_isolationtestkey", { fetch: isolated.fetch }).mcpProfileArn()
    expect(isolated.calls).toHaveLength(1)
    expect(isolatedArn).toBe(`${REAL_ARN}-ISOLATED`)
  })

  it("api: reports a rejected key clearly", async () => {
    const { fetch } = scriptedFetch(() => new Response("{}", { status: 403 }), { onExhausted: "repeat-last" })
    const allFailedMessage = messageOf(await rejectionOf(fetchApiKeyProfileArn(API_KEY, { fetch })))
    expect(allFailedMessage).toContain("could not use the configured credential")
    expect(allFailedMessage).not.toContain("app.kiro.dev")
    expect(allFailedMessage).not.toContain(API_KEY)
  })
})
