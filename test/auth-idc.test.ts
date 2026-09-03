import { describe, expect, it } from "bun:test"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  encodeRefreshState,
  KiroAuthError,
  normalizeRegion,
  normalizeStartUrl,
  refreshOAuthCredential,
  type OAuthCredential,
  type PendingDeviceAuthorization,
  type RefreshState,
} from "../src/auth"
import { REFRESH_STATE_PREFIX } from "../src/constants"
import { jsonResponse, messageOf, rejectionOf, scriptedFetch, thrownMessage } from "./support/http-fixtures"

const IDC_STATE: RefreshState = {
  version: 1,
  refreshToken: "refresh-idc-1",
  clientId: "client-idc",
  clientSecret: "secret-idc",
  region: "eu-west-1",
  startUrl: "https://acme.awsapps.com/start",
  authMethod: "idc",
}

/** Pack a deliberately malformed state with the real encoder; only its shape is faked. */
const encodeMalformedState = (state: object) => encodeRefreshState(state as RefreshState)

describe("IAM Identity Center input normalization", () => {
  it("accepts an https start URL and strips one trailing slash", () => {
    expect(normalizeStartUrl("https://acme.awsapps.com/start/")).toBe("https://acme.awsapps.com/start")
    expect(normalizeStartUrl("  https://acme.awsapps.com/start  ")).toBe("https://acme.awsapps.com/start")
    expect(normalizeStartUrl("https://acme.awsapps.com")).toBe("https://acme.awsapps.com")
  })

  it("rejects http, userinfo, fragment, and unparseable start URLs with one message", () => {
    const messages = new Set<string | undefined>()
    for (const value of [
      "http://acme.awsapps.com/start",
      "https://user:pw@acme.awsapps.com/start",
      "https://acme.awsapps.com/start#frag",
      "not a url",
      "",
    ]) {
      const normalize = () => normalizeStartUrl(value)
      expect(normalize).toThrow(KiroAuthError)
      messages.add(thrownMessage(normalize))
    }
    expect(messages.size).toBe(1)
    expect([...messages][0]).toContain("HTTPS")
  })

  it("trims and lowercases a region", () => {
    expect(normalizeRegion("  EU-West-1 ")).toBe("eu-west-1")
    expect(normalizeRegion("us-gov-west-1")).toBe("us-gov-west-1")
  })

  it("rejects a malformed region", () => {
    for (const value of ["us-east", "useast1", "", "eu-west-1a", "us east 1"]) {
      const normalize = () => normalizeRegion(value)
      expect(normalize).toThrow(KiroAuthError)
      expect(thrownMessage(normalize)).toContain("Invalid AWS region")
    }
  })
})

describe("IAM Identity Center device authorization", () => {
  it("registers and starts the device flow against the region's OIDC endpoint with the normalized start URL", async () => {
    const { fetch, calls } = scriptedFetch(
      jsonResponse({ clientId: "client-idc", clientSecret: "secret-idc", clientSecretExpiresAt: 9_999_999_999 }),
      jsonResponse({
        deviceCode: "device-idc",
        userCode: "IDCX-CODE",
        verificationUri: "https://device.sso.eu-west-1.amazonaws.com/",
        expiresIn: 300,
        interval: 1,
      }),
    )

    const pending = await beginDeviceAuthorization(
      { authMethod: "idc", startUrl: "https://acme.awsapps.com/start/", region: " EU-WEST-1 " },
      { fetch, now: () => 1_000 },
    )

    expect(calls.map((call) => call.url)).toEqual([
      "https://oidc.eu-west-1.amazonaws.com/client/register",
      "https://oidc.eu-west-1.amazonaws.com/device_authorization",
    ])
    expect(calls[1]?.body).toEqual({
      clientId: "client-idc",
      clientSecret: "secret-idc",
      startUrl: "https://acme.awsapps.com/start",
    })
    expect(pending.authMethod).toBe("idc")
    expect(pending.region).toBe("eu-west-1")
    expect(pending.startUrl).toBe("https://acme.awsapps.com/start")
    expect(pending.expiresAt).toBe(1_000 + 300_000)
    expect(pending.intervalSeconds).toBe(1)
    expect(pending.verificationUriComplete).toBeUndefined()
  })

  it("rejects invalid IdC input before contacting OIDC", async () => {
    const { fetch, calls } = scriptedFetch()

    const badRegion = await rejectionOf(
      beginDeviceAuthorization({ authMethod: "idc", startUrl: "https://acme.awsapps.com/start", region: "nope" }, { fetch }),
    )
    const badUrl = await rejectionOf(
      beginDeviceAuthorization({ authMethod: "idc", startUrl: "http://acme.awsapps.com/start", region: "eu-west-1" }, { fetch }),
    )
    expect(messageOf(badRegion)).toContain("Invalid AWS region")
    expect(thrownMessage(() => normalizeStartUrl("http://acme.awsapps.com/start"))).toBe(messageOf(badUrl))
    expect(calls).toHaveLength(0)
  })

  function pendingIdc(overrides: Partial<PendingDeviceAuthorization> = {}): PendingDeviceAuthorization {
    return {
      clientId: "client-idc",
      clientSecret: "secret-idc",
      region: "eu-west-1",
      startUrl: "https://acme.awsapps.com/start",
      authMethod: "idc",
      deviceCode: "device-idc",
      userCode: "IDCX-CODE",
      verificationUri: "https://device.sso.eu-west-1.amazonaws.com/",
      expiresAt: 1_000 + 600_000,
      intervalSeconds: 1,
      ...overrides,
    }
  }

  it("fails hard on access_denied with the redacted OIDC detail", async () => {
    const { fetch, calls } = scriptedFetch(
      jsonResponse({ error: "access_denied", error_description: "User declined ksk_secretvalue" }, { status: 400 }),
    )

    const error = await rejectionOf(
      completeDeviceAuthorization(pendingIdc(), { fetch, now: () => 1_000, sleep: async () => {} }),
    )
    expect(error).toBeInstanceOf(KiroAuthError)
    expect(messageOf(error)).toContain("400")
    expect(messageOf(error)).toContain("access_denied")
    expect(calls).toHaveLength(1)
  })

  it("redacts secrets carried in the OIDC error detail", async () => {
    const { fetch } = scriptedFetch(
      jsonResponse({ error: `denied for ksk_secretvalue and ${encodeRefreshState(IDC_STATE)}` }, { status: 400 }),
    )

    const error = await rejectionOf(
      completeDeviceAuthorization(pendingIdc(), { fetch, now: () => 1_000, sleep: async () => {} }),
    )
    const message = messageOf(error)
    expect(message).not.toContain("ksk_secretvalue")
    expect(message).toContain("ksk_<redacted>")
    expect(message).not.toContain(encodeRefreshState(IDC_STATE))
    expect(message).toContain(`${REFRESH_STATE_PREFIX}<redacted>`)
  })

  it("keeps polling through a thrown fetch, 429, and 5xx until the token arrives", async () => {
    const waits: number[] = []
    const { fetch, calls } = scriptedFetch(
      new TypeError("connection reset"),
      jsonResponse({ message: "throttled" }, { status: 429 }),
      jsonResponse({ message: "unavailable" }, { status: 503 }),
      jsonResponse({ accessToken: "access-idc", refreshToken: "refresh-idc-1", expiresIn: 1800 }),
    )

    const credential = await completeDeviceAuthorization(pendingIdc(), {
      fetch,
      now: () => 1_000,
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(calls).toHaveLength(4)
    expect(calls.every((call) => call.url === "https://oidc.eu-west-1.amazonaws.com/token")).toBe(true)
    expect(calls[0]?.body).toHaveProperty("grantType", "urn:ietf:params:oauth:grant-type:device_code")
    expect(waits).toEqual([1000, 1000, 1000, 1000])
    expect(credential.access).toBe("access-idc")
    expect(credential.expires).toBe(1_000 + 1_800_000)
    const state = decodeRefreshState(credential.refresh)
    expect(state.authMethod).toBe("idc")
    expect(state.region).toBe("eu-west-1")
    expect(state.startUrl).toBe("https://acme.awsapps.com/start")
    expect(state.refreshToken).toBe("refresh-idc-1")
  })

  it(
    "times out once the clock passes expiresAt while authorization stays pending",
    async () => {
      let clock = 1_000
      const { fetch, calls } = scriptedFetch(
        ...Array.from({ length: 10 }, () => jsonResponse({ error: "authorization_pending" }, { status: 400 })),
      )

      const error = await rejectionOf(
        completeDeviceAuthorization(pendingIdc({ expiresAt: 1_000 + 2_500, intervalSeconds: 1 }), {
          fetch,
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds
          },
        }),
      )

      expect(error).toBeInstanceOf(KiroAuthError)
      expect(messageOf(error)).toContain("timed out")
      // Polls at t=2000 and t=3000 only; the poll that would land past expiresAt never happens.
      expect(calls).toHaveLength(2)
    },
    1_000,
  )
})

describe("refresh state decoding", () => {
  it("rejects an unsupported prefix", () => {
    const decode = () => decodeRefreshState("some-other-scheme:abc")
    expect(decode).toThrow(KiroAuthError)
    expect(thrownMessage(decode)).toContain("unsupported")
  })

  it("rejects a corrupt payload", () => {
    const decode = () => decodeRefreshState(`${REFRESH_STATE_PREFIX}!!!not-json!!!`)
    expect(decode).toThrow(KiroAuthError)
    expect(thrownMessage(decode)).toContain("corrupt")
  })

  it("rejects an incomplete state", () => {
    for (const state of [
      { version: 1 },
      { ...IDC_STATE, refreshToken: "" },
      { ...IDC_STATE, authMethod: "saml" },
      { ...IDC_STATE, version: 2 },
    ]) {
      const decode = () => decodeRefreshState(encodeMalformedState(state))
      expect(decode).toThrow(KiroAuthError)
      expect(thrownMessage(decode)).toContain("incomplete")
    }
  })

  it("the three failure messages are distinct", () => {
    const messages = new Set(
      [
        "some-other-scheme:abc",
        `${REFRESH_STATE_PREFIX}!!!not-json!!!`,
        encodeMalformedState({ version: 1 }),
      ].map((value) => thrownMessage(() => decodeRefreshState(value))),
    )
    expect(messages.size).toBe(3)
  })

  it("round-trips a complete IdC state", () => {
    expect(decodeRefreshState(encodeRefreshState(IDC_STATE))).toEqual(IDC_STATE)
  })
})

describe("IAM Identity Center token refresh", () => {
  function idcCredential(state: RefreshState = IDC_STATE): OAuthCredential {
    return { type: "oauth", access: "", refresh: encodeRefreshState(state), expires: 0 }
  }

  it("refuses an expired client registration without calling OIDC", async () => {
    const { fetch, calls } = scriptedFetch()
    // clientSecretExpiresAt is in seconds; 1_000_000 s is well before now (2_000_000 s) plus skew.
    const credential = idcCredential({ ...IDC_STATE, clientSecretExpiresAt: 1_000_000 })

    const error = await rejectionOf(refreshOAuthCredential(credential, { fetch, now: () => 2_000_000_000 }))
    expect(error).toBeInstanceOf(KiroAuthError)
    expect(messageOf(error)).toContain("client registration expired")
    expect(calls).toHaveLength(0)
  })

  it("treats a registration expiring inside the skew window as expired", async () => {
    const { fetch, calls } = scriptedFetch()
    const now = 2_000_000_000
    // Expires 60 s from now: inside the five-minute skew, so it is not worth a refresh.
    const credential = idcCredential({ ...IDC_STATE, clientSecretExpiresAt: now / 1000 + 60 })

    const error = await rejectionOf(refreshOAuthCredential(credential, { fetch, now: () => now }))
    expect(messageOf(error)).toContain("client registration expired")
    expect(calls).toHaveLength(0)
  })

  it("posts the refresh grant to the region's OIDC endpoint and adopts a rotated refresh token", async () => {
    const { fetch, calls } = scriptedFetch(
      jsonResponse({ accessToken: "access-idc-2", refreshToken: "refresh-idc-2", expiresIn: 900 }),
    )

    const next = await refreshOAuthCredential(idcCredential(), { fetch, now: () => 5_000 })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://oidc.eu-west-1.amazonaws.com/token")
    expect(calls[0]?.body).toEqual({
      clientId: "client-idc",
      clientSecret: "secret-idc",
      refreshToken: "refresh-idc-1",
      grantType: "refresh_token",
    })
    expect(next.access).toBe("access-idc-2")
    expect(next.expires).toBe(5_000 + 900_000)
    expect(decodeRefreshState(next.refresh)).toEqual({ ...IDC_STATE, refreshToken: "refresh-idc-2" })
  })

  it("keeps the previous refresh token when OIDC does not rotate it", async () => {
    const { fetch } = scriptedFetch(jsonResponse({ accessToken: "access-idc-2", expiresIn: 900 }))

    const next = await refreshOAuthCredential(idcCredential(), { fetch, now: () => 5_000 })
    expect(decodeRefreshState(next.refresh).refreshToken).toBe("refresh-idc-1")
  })

  it("surfaces an OIDC refresh failure as a KiroAuthError with the redacted detail", async () => {
    const { fetch } = scriptedFetch(
      jsonResponse({ error: "invalid_grant", error_description: "token ksk_leaked" }, { status: 400 }),
    )

    const error = await rejectionOf(refreshOAuthCredential(idcCredential(), { fetch, now: () => 5_000 }))
    expect(error).toBeInstanceOf(KiroAuthError)
    expect(messageOf(error)).toContain("Kiro token refresh failed (400)")
    expect(messageOf(error)).toContain("invalid_grant")
    expect(messageOf(error)).not.toContain("ksk_leaked")
  })
})
