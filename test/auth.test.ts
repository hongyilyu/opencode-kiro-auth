import { beforeAll, describe, expect, it } from "bun:test"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroCredentialManager,
  type OAuthCredential,
} from "../src/auth"
import { createSession } from "../src/session"
import { jsonResponse, messageOf, rejectionOf, scriptedFetch, thrownMessage } from "./support/http-fixtures"

describe("device authorization flow", () => {
  // Scripted OIDC exchange: register client -> start device flow -> pending -> slow_down -> token.
  const deviceFlow = scriptedFetch(
    jsonResponse({ clientId: "client-1", clientSecret: "secret-1", clientSecretExpiresAt: 9_999_999_999 }),
    jsonResponse({
      deviceCode: "device-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 2,
    }),
    jsonResponse({ error: "authorization_pending" }, { status: 400 }),
    jsonResponse({ error: "slow_down" }, { status: 400 }),
    jsonResponse({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
  )
  const waits: number[] = []
  let credential: OAuthCredential

  beforeAll(async () => {
    const pending = await beginDeviceAuthorization(
      { authMethod: "builder-id" },
      { fetch: deviceFlow.fetch, now: () => 1_000 },
    )
    credential = await completeDeviceAuthorization(pending, {
      fetch: deviceFlow.fetch,
      now: () => 1_000,
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })
  })

  it("registers independent OAuth client", () => {
    expect(deviceFlow.calls[0]?.url).toBe("https://oidc.us-east-1.amazonaws.com/client/register")
    expect(deviceFlow.calls[0]?.body).toHaveProperty("clientName", "opencode-kiro-auth")
    expect(deviceFlow.calls[0]?.body).toHaveProperty("clientType", "public")
  })

  it("starts Builder ID device flow", () => {
    expect(deviceFlow.calls[1]?.url).toBe("https://oidc.us-east-1.amazonaws.com/device_authorization")
    expect(deviceFlow.calls[1]?.body).toHaveProperty("startUrl", "https://view.awsapps.com/start")
  })

  it("polls pending and slow-down responses", () => {
    expect(waits.join(",")).toBe("2000,2000,7000")
    expect(deviceFlow.calls).toHaveLength(5)
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
    type ManagerOptions = {
      /** Store reader; defaults to the always-stale credential. */
      read?: () => Promise<unknown>
      /** Store writer; the helper counts every attempt and records the last successful write. */
      write?: (next: OAuthCredential) => Promise<void>
      /** When set, OIDC rotates the refresh token on every refresh (`refresh-2`, `refresh-3`, ...). */
      rotate?: boolean
      /** The first N OIDC refresh calls answer 400 invalid_grant. */
      oidcFailures?: number
    }

    /**
     * A manager whose stored credential is expired by default, so every read forces a refresh.
     * The OIDC mock answers `access-<n+1>` on its n-th call and records each refreshToken it is
     * asked to exchange, so a test can prove which token (rotated or superseded) was sent.
     */
    function refreshingManager(options: ManagerOptions = {}) {
      let refreshCalls = 0
      let writes = 0
      const receivedRefreshTokens: unknown[] = []
      let persisted: OAuthCredential | undefined
      const stale: OAuthCredential = { ...credential, access: "", expires: 0 }
      const write = options.write ?? (async () => {})
      const oidc = scriptedFetch(
        (call) => {
          refreshCalls++
          receivedRefreshTokens.push((call.body as { refreshToken?: unknown }).refreshToken)
          if (refreshCalls <= (options.oidcFailures ?? 0)) {
            return jsonResponse({ error: "invalid_grant" }, { status: 400 })
          }
          return jsonResponse({
            accessToken: `access-${refreshCalls + 1}`,
            refreshToken: options.rotate ? `refresh-${refreshCalls + 1}` : undefined,
            expiresIn: 3600,
          })
        },
        { onExhausted: "repeat-last" },
      )
      const manager = new KiroCredentialManager(
        options.read ?? (async () => stale),
        async (next) => {
          writes++
          await write(next)
          persisted = next
        },
        { now: () => 2_000, fetch: oidc.fetch },
      )
      return {
        manager,
        stale,
        refreshCalls: () => refreshCalls,
        writes: () => writes,
        receivedRefreshTokens,
        persisted: () => persisted,
      }
    }

    /** A writer that rejects its first `times` calls and succeeds afterwards. */
    function failingWriter(times: number) {
      let attempts = 0
      return async () => {
        attempts++
        if (attempts <= times) throw new Error("auth store is read-only")
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
      const profile = scriptedFetch(() => jsonResponse({ profiles: [{ arn }] }), { onExhausted: "repeat-last" })
      const oauthSession = createSession({ mode: "oauth", credentials: manager }, { fetch: profile.fetch })
      const oauthHeaders = await oauthSession.authHeaders()
      expect(oauthHeaders.tokentype).toBeUndefined()
      expect(oauthHeaders.authorization).toBe("Bearer access-2")
      expect(await oauthSession.chatProfileArn()).toBe(arn)
      expect(await oauthSession.mcpProfileArn()).toBe(arn)
    })

    it("keeps the rotated refresh token when persistence fails once and persists it on the next call without a second OIDC refresh", async () => {
      const m = refreshingManager({ rotate: true, write: failingWriter(1) })

      expect(messageOf(await rejectionOf(m.manager.getAccessToken()))).toContain("read-only")
      expect(m.persisted()).toBeUndefined()

      expect(await m.manager.getAccessToken()).toBe("access-2")
      expect(m.refreshCalls()).toBe(1)
      expect(m.receivedRefreshTokens).toEqual(["refresh-1"])
      expect(m.writes()).toBe(2)
      expect(decodeRefreshState(m.persisted()!.refresh).refreshToken).toBe("refresh-2")
    })

    it("rejects every call while persistence keeps failing without re-hitting OIDC", async () => {
      const m = refreshingManager({ rotate: true, write: failingWriter(Infinity) })

      for (let call = 0; call < 3; call++) {
        expect(messageOf(await rejectionOf(m.manager.getAccessToken()))).toContain("read-only")
      }
      expect(m.refreshCalls()).toBe(1)
      expect(m.receivedRefreshTokens).toEqual(["refresh-1"])
      expect(m.writes()).toBe(3)
      expect(m.persisted()).toBeUndefined()
    })

    it("concurrent callers after a failed persist share one persist retry", async () => {
      const m = refreshingManager({ rotate: true, write: failingWriter(1) })
      await rejectionOf(m.manager.getAccessToken())

      const tokens = await Promise.all([m.manager.getAccessToken(), m.manager.getAccessToken()])
      expect(tokens).toEqual(["access-2", "access-2"])
      expect(m.writes()).toBe(2)
      expect(m.refreshCalls()).toBe(1)
    })

    it("drops the held credential when another writer replaced the stored one", async () => {
      // The stored `refresh` string is an opaque tag to the manager; a re-login produces one that
      // matches neither what we replaced (refresh-1 state) nor what we hold (refresh-2 state).
      const relogin: OAuthCredential = {
        type: "oauth",
        access: "relogin-access",
        refresh: `${credential.refresh}-relogin`,
        expires: 2_000 + 3_600_000,
      }
      let stored: OAuthCredential | undefined
      const m = refreshingManager({
        rotate: true,
        write: failingWriter(1),
        read: async () => stored ?? m.stale,
      })
      await rejectionOf(m.manager.getAccessToken())

      stored = relogin
      expect(await m.manager.getAccessToken()).toBe("relogin-access")
      expect(m.refreshCalls()).toBe(1)
      expect(m.writes()).toBe(1)

      // The held credential is gone for good: a later stale read refreshes instead of serving it.
      stored = m.stale
      expect(await m.manager.getAccessToken()).toBe("access-3")
      expect(m.refreshCalls()).toBe(2)
    })

    it("does not re-refresh when the store ignores writes", async () => {
      const m = refreshingManager({ rotate: true })

      expect(await m.manager.getAccessToken()).toBe("access-2")
      expect(await m.manager.getAccessToken()).toBe("access-2")
      expect(await m.manager.getAccessToken()).toBe("access-2")
      expect(m.refreshCalls()).toBe(1)
      expect(m.writes()).toBe(1)
    })

    it("concurrent callers share one failed refresh", async () => {
      const m = refreshingManager({ rotate: true, oidcFailures: 1 })

      const errors = await Promise.all([
        rejectionOf(m.manager.getAccessToken()),
        rejectionOf(m.manager.getAccessToken()),
      ])
      for (const error of errors) expect(messageOf(error)).toContain("invalid_grant")
      expect(m.refreshCalls()).toBe(1)
      expect(m.writes()).toBe(0)

      // Nothing is held after a failed refresh, so the next call tries OIDC again.
      expect(await m.manager.getAccessToken()).toBe("access-3")
      expect(m.refreshCalls()).toBe(2)
      expect(m.receivedRefreshTokens).toEqual(["refresh-1", "refresh-1"])
    })

    it("a stale re-read after a completed refresh serves the held credential", async () => {
      let stored: OAuthCredential | undefined
      const m = refreshingManager({ rotate: true, read: async () => stored ?? m.stale })

      expect(await m.manager.getAccessToken()).toBe("access-2")
      // The write landed but the reader still returns the old credential.
      expect(await m.manager.getAccessToken()).toBe("access-2")
      expect(m.refreshCalls()).toBe(1)
      expect(m.writes()).toBe(1)

      // Once the reader catches up, the store wins and nothing else is written or refreshed.
      stored = m.persisted()
      expect(await m.manager.getAccessToken()).toBe("access-2")
      expect(m.refreshCalls()).toBe(1)
      expect(m.writes()).toBe(1)
    })

    it("a removed credential still throws even with a held credential", async () => {
      let signedOut = false
      const m = refreshingManager({
        rotate: true,
        write: failingWriter(1),
        read: async () => (signedOut ? undefined : m.stale),
      })
      await rejectionOf(m.manager.getAccessToken())

      signedOut = true
      expect(messageOf(await rejectionOf(m.manager.getAccessToken()))).toContain("opencode auth login --provider kiro")
      expect(m.refreshCalls()).toBe(1)
      expect(m.writes()).toBe(1)
    })
  })
})

describe("credential migration", () => {
  it("rejects legacy kiro-cli sentinel", () => {
    expect(thrownMessage(() => decodeRefreshState("kiro-cli-managed"))).toContain("opencode auth login --provider kiro")
  })
})
