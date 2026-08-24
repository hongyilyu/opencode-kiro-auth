import { beforeAll, describe, expect, it } from "bun:test"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroCredentialManager,
  type OAuthCredential,
} from "../src/auth"
import { createSession } from "../src/session"
import { getProfileArn } from "../src/profile"

describe("device authorization flow", () => {
  // Scripted OIDC exchange: register client -> start device flow -> pending -> slow_down -> token.
  const calls: Array<{ url: string; body: any }> = []
  const waits: number[] = []
  let credential: OAuthCredential

  beforeAll(async () => {
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
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
    credential = await completeDeviceAuthorization(pending, {
      fetch: mockFetch as typeof fetch,
      now: () => 1_000,
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })
  })

  it("registers independent OAuth client", () => {
    expect(calls[0]?.url).toBe("https://oidc.us-east-1.amazonaws.com/client/register")
    expect(calls[0]?.body?.clientName).toBe("opencode-kiro-auth")
    expect(calls[0]?.body?.clientType).toBe("public")
  })

  it("starts Builder ID device flow", () => {
    expect(calls[1]?.url).toBe("https://oidc.us-east-1.amazonaws.com/device_authorization")
    expect(calls[1]?.body?.startUrl).toBe("https://view.awsapps.com/start")
  })

  it("polls pending and slow-down responses", () => {
    expect(waits.join(",")).toBe("2000,2000,7000")
    expect(calls).toHaveLength(5)
  })

  it("stores self-contained refresh state", () => {
    const state = decodeRefreshState(credential.refresh)
    expect(credential.access).toBe("access-1")
    expect(state.refreshToken).toBe("refresh-1")
    expect(state.clientId).toBe("client-1")
    expect(state.clientSecret).toBe("secret-1")
    expect(state.authMethod).toBe("builder-id")
  })

  describe("credential refresh", () => {
    /** A manager whose stored credential is always expired, so every read forces a refresh. */
    function refreshingManager() {
      let refreshCalls = 0
      let persisted: OAuthCredential | undefined
      const manager = new KiroCredentialManager(
        async () => ({ ...credential, access: "", expires: 0 }),
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
      return {
        manager,
        refreshCalls: () => refreshCalls,
        persisted: () => persisted,
      }
    }

    it("deduplicates concurrent refresh", async () => {
      const { manager, refreshCalls } = refreshingManager()
      const refreshed = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
      expect(refreshCalls()).toBe(1)
      for (const token of refreshed) expect(token).toBe("access-2")
    })

    it("persists refreshed credential", async () => {
      const { manager, persisted } = refreshingManager()
      await manager.getAccessToken()
      expect(persisted()?.access).toBe("access-2")
      expect(decodeRefreshState(persisted()!.refresh).refreshToken).toBe("refresh-1")
    })

    it("oauth: no tokentype header, resolves profileArn for chat and MCP", async () => {
      const { manager } = refreshingManager()
      const arn = "arn:aws:codewhisperer:us-east-1:111122223333:profile/OAUTHTEST"
      const profileFetch = (async () =>
        new Response(JSON.stringify({ profiles: [{ arn }] }))) as unknown as typeof fetch
      const oauthSession = createSession(credential, manager, { fetch: profileFetch })
      const oauthHeaders = await oauthSession.authHeaders()
      expect(oauthHeaders.tokentype).toBeUndefined()
      expect(oauthHeaders.authorization).toBe("Bearer access-2")
      expect(await oauthSession.chatProfileArn()).toBe(arn)
      expect(await oauthSession.mcpProfileArn()).toBe(arn)
    })
  })
})

describe("credential migration", () => {
  it("rejects legacy kiro-cli sentinel", () => {
    let migrationMessage = ""
    try {
      decodeRefreshState("kiro-cli-managed")
    } catch (error) {
      migrationMessage = error instanceof Error ? error.message : String(error)
    }
    expect(migrationMessage).toContain("opencode auth login --provider kiro")
  })
})

describe("oauth profile resolution", () => {
  it("oauth: profile cache is token-specific", async () => {
    const REAL_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/TESTPROFILE"
    let oauthProfileCalls = 0
    // Distinct fetch instance: the profile cache is keyed per fetch function (WeakMap),
    // so a fresh instance guarantees isolation from other tests.
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
    expect(oauthProfileCalls).toBe(2)
    expect(oauthArns.join(",")).toBe(`${REAL_ARN}-A,${REAL_ARN}-B,${REAL_ARN}-A`)
  })
})
