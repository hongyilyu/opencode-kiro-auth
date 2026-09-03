import { describe, expect, it } from "bun:test"
import { isApiKeyCredential, normalizeApiKey, readApiKeyFromEnv } from "../src/apikey"
import { KiroCredentialManager, type OAuthCredential } from "../src/auth"
import { createApiKeySession, createSession } from "../src/session"
import { messageOf, rejectionOf, thrownMessage } from "./support/http-fixtures"

const API_KEY = "ksk_offlinetestkey"

// Shape-only stand-ins for the split tests: both throw before ever being used for real work.
const oauthShapedCredential: OAuthCredential = { type: "oauth", access: "access-1", refresh: "refresh-state", expires: 1 }
const unusedManager = new KiroCredentialManager(
  async () => oauthShapedCredential,
  async () => {},
)

describe("api key validation", () => {
  it("api: recognizes stored api credential", () => {
    expect(isApiKeyCredential({ type: "api", key: API_KEY })).toBe(true)
    expect(isApiKeyCredential({ type: "api", key: "" })).toBe(false)
    expect(isApiKeyCredential(oauthShapedCredential)).toBe(false)
  })

  it("api: rejects malformed key without format guidance", () => {
    const badPrefix = thrownMessage(() => normalizeApiKey("sk-not-a-kiro-key"))
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

describe("session mode splitting", () => {
  it("api: env var used only as fallback", async () => {
    const envOnly = createSession({ mode: "api", credential: undefined, envKey: API_KEY })
    expect((await envOnly.authHeaders()).tokentype).toBe("API_KEY")
    const stored = createSession({ mode: "api", credential: { type: "api", key: "ksk_storedkey" }, envKey: API_KEY })
    expect((await stored.authHeaders()).authorization).toBe("Bearer ksk_storedkey")
  })

  it("api: no credential still errors", () => {
    const noCredentialMessage = thrownMessage(() =>
      createSession({ mode: "api", credential: undefined, envKey: undefined }),
    )
    expect(noCredentialMessage).toContain("auth login")
  })

  it("api: reports an unusable configured credential generically", () => {
    const badEnvMessage = thrownMessage(() =>
      createSession({ mode: "api", credential: undefined, envKey: "not-a-kiro-key" }),
    )
    expect(badEnvMessage).toContain("configured Kiro credential is unusable")
    expect(badEnvMessage).not.toContain("KIRO_API_KEY")
    expect(badEnvMessage).not.toContain("ksk_")
  })

  it("split: api provider rejects an oauth credential", () => {
    const apiModeRejects =
      thrownMessage(() => createSession({ mode: "api", credential: oauthShapedCredential, envKey: undefined })) ?? ""
    expect(apiModeRejects.includes("kiro-api") || apiModeRejects.includes("KIRO_API_KEY")).toBe(true)
  })

  it("split: api provider reads env key", async () => {
    const session = createSession({ mode: "api", credential: undefined, envKey: API_KEY })
    expect((await session.authHeaders()).tokentype).toBe("API_KEY")
  })

  it("split: the api session spec has no credentials slot", () => {
    // Compile-time contract: the closure is never invoked; `bun run typecheck` fails if the
    // expected error disappears (an API-key session must not be handed the OAuth manager).
    const buildWithManager = () =>
      // @ts-expect-error the api spec has no credentials slot
      createSession({ mode: "api", credential: undefined, credentials: unusedManager })
    expect(typeof buildWithManager).toBe("function")
  })

  it("split: oauth provider rejects an api credential", async () => {
    // The store is the manager's to validate: an api-shaped record surfaces when the token is used.
    const apiBackedManager = new KiroCredentialManager(
      async () => ({ type: "api", key: API_KEY }),
      async () => {},
    )
    const session = createSession({ mode: "oauth", credentials: apiBackedManager })
    const oauthModeRejectsApi = messageOf(await rejectionOf(session.authHeaders()))
    expect(oauthModeRejectsApi).toContain("OAuth")
    expect(oauthModeRejectsApi).toContain("provider kiro")
  })
})
