import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createKiroPlugin, KiroApiKeyPlugin, KiroAuthPlugin } from "../src/plugin"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroAuthError,
  normalizeRegion,
  normalizeStartUrl,
  type OAuthCredential,
} from "../src/auth"
import { KIRO_ENDPOINT, KIRO_MANAGEMENT_ENDPOINT } from "../src/constants"
import { isolateEnv } from "./support/isolation"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { jsonResponse, messageOf, rejectionOf, scriptedFetch, thrownMessage, routedFetch, type RoutedFetch } from "./support/http-fixtures"
import { fakePluginInput } from "./support/plugin-fixtures"

// A fake opencode client: session.message resolves the provider that produced a message,
// which is all the plugin needs for web_search routing; auth.set is never exercised here.
const fakeClient = {
  session: {
    message: async ({ path }: any) => ({
      data: {
        info: {
          role: "assistant",
          providerID: path.messageID === "api-message" ? "kiro-api" : "kiro",
        },
      },
    }),
  },
  auth: { set: async () => ({}) },
} as any

const pluginInput = fakePluginInput({ client: fakeClient })
const hooks = await KiroAuthPlugin(pluginInput)
const apiHooks = await KiroApiKeyPlugin(pluginInput)

// Only the exact active model may expose one of its configured variants as effort.
describe("chat.headers effort gating", () => {
  const effortHeader = async (activeModel: string, supported: string[], selectedModel: string, variant: string) => {
    const output = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(
      {
        model: {
          id: activeModel,
          providerID: "kiro",
          variants: Object.fromEntries(supported.map((value) => [value, {}])),
        },
        message: { model: { providerID: "kiro", modelID: selectedModel, variant } },
      } as any,
      output,
    )
    return output.headers["x-kiro-effort"]
  }

  it("matching model exposes effort", async () => {
    expect(await effortHeader("gpt-5.6-sol", ["max"], "gpt-5.6-sol", "max")).toBe("max")
  })

  it("auxiliary model drops effort", async () => {
    expect(await effortHeader("claude-haiku-4.5", [], "gpt-5.6-sol", "max")).toBeUndefined()
  })

  it("unsupported effort dropped", async () => {
    expect(await effortHeader("claude-sonnet-5", ["low"], "claude-sonnet-5", "max")).toBeUndefined()
  })
})

// The kiro-api provider mirrors the kiro provider's config unless explicitly configured.
describe("kiro-api config mirroring", () => {
  const mirrored = async (input: any) => {
    await apiHooks.config!(input)
    return input.provider?.["kiro-api"]
  }

  it("kiro-api inherits kiro models", async () => {
    const fromKiro = await mirrored({
      provider: { kiro: { name: "Kiro", npm: "@ai-sdk/anthropic", models: { "claude-sonnet-4.6": {} } } },
    })
    expect(Object.keys(fromKiro?.models ?? {})).toEqual(["claude-sonnet-4.6"])
    expect(fromKiro?.npm).toBe("@ai-sdk/anthropic")
  })

  it("kiro-api gets a distinct name", async () => {
    const fromKiro = await mirrored({
      provider: { kiro: { name: "Kiro", npm: "@ai-sdk/anthropic", models: { "claude-sonnet-4.6": {} } } },
    })
    expect(fromKiro?.name).toBe("Kiro (API key)")
  })

  it("explicit kiro-api config preserved", async () => {
    const overridden = await mirrored({
      provider: {
        kiro: { name: "Kiro", models: { "claude-sonnet-4.6": {} } },
        "kiro-api": { name: "Custom", models: { "claude-opus-5": {} } },
      },
    })
    expect(overridden?.name).toBe("Custom")
    expect(Object.keys(overridden?.models ?? {})).toEqual(["claude-opus-5"])
  })

  it("partial kiro-api config inherits models", async () => {
    const partialOverride = await mirrored({
      provider: {
        kiro: {
          name: "Kiro",
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://kiro.local" },
          models: { "claude-sonnet-4.6": {} },
        },
        "kiro-api": { name: "Custom", options: { custom: true } },
      },
    })
    expect(Object.keys(partialOverride?.models ?? {})).toEqual(["claude-sonnet-4.6"])
    expect(partialOverride?.npm).toBe("@ai-sdk/anthropic")
    expect(partialOverride?.options?.baseURL).toBe("https://kiro.local")
    expect(partialOverride?.options?.custom).toBe(true)
    expect(typeof partialOverride?.options?.fetch).toBe("function")
    expect(partialOverride?.options?.apiKey).toBe("")
  })

  it("no kiro block -> no kiro-api injected", async () => {
    expect(await mirrored({ provider: {} })).toBeUndefined()
  })
})

describe("auth methods", () => {
  it("kiro exposes only device flows", () => {
    const oauthLabels = (hooks.auth!.methods as any[]).map((m) => `${m.type}:${m.label}`)
    expect(hooks.auth!.provider).toBe("kiro")
    expect(oauthLabels).toHaveLength(2)
    for (const label of oauthLabels) expect(label).toStartWith("oauth:")
  })

  it("kiro-api exposes only the api method", () => {
    const apiLabels = (apiHooks.auth!.methods as any[]).map((m) => `${m.type}:${m.label}`)
    expect(apiHooks.auth!.provider).toBe("kiro-api")
    expect(apiLabels).toHaveLength(1)
    expect(apiLabels[0]).toStartWith("api:")
  })
})

describe("web_search tool", () => {
  isolateEnv("KIRO_API_KEY")

  it("web_search registered once", () => {
    expect(hooks.tool).toBeUndefined()
    expect(Object.keys(apiHooks.tool ?? {})).toEqual(["web_search"])
  })

  const toolError = async (messageID: string) =>
    messageOf(
      await rejectionOf(
        apiHooks.tool!.web_search.execute(
          { query: "test" },
          { sessionID: "session", messageID, directory: "/tmp" } as never,
        ),
      ),
    )

  it("web_search routes to oauth provider", async () => {
    delete process.env.KIRO_API_KEY
    expect(await toolError("oauth-message")).toContain("provider kiro")
  })

  it("web_search routes to api provider", async () => {
    delete process.env.KIRO_API_KEY
    expect(await toolError("api-message")).toContain("auth login --provider kiro-api")
  })
})


/* ------------------------- helpers for the loader and login paths ------------------------- */

const OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com"
const OIDC_TOKEN_URL = `${OIDC_ENDPOINT}/token`


/** The authorization header sent to the Kiro chat endpoint, or null when no chat call was made. */
function chatAuthorization(upstream: RoutedFetch): string | null {
  const chat = upstream.calls.find((call) => call.url.startsWith(KIRO_ENDPOINT))
  return new Headers(chat?.init?.headers).get("authorization")
}

/** A real self-contained credential produced by the device flow, then expired so the loader must refresh. */
async function expiredDeviceFlowCredential(): Promise<OAuthCredential> {
  const oidc = scriptedFetch(
    jsonResponse({ clientId: "client-1", clientSecret: "secret-1", clientSecretExpiresAt: 9_999_999_999 }),
    jsonResponse({ deviceCode: "device-1", userCode: "ABCD-EFGH", verificationUri: "https://device.sso.us-east-1.amazonaws.com/" }),
    jsonResponse({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
  )
  const pending = await beginDeviceAuthorization({ authMethod: "builder-id" }, { fetch: oidc.fetch, now: () => 1_000 })
  const credential = await completeDeviceAuthorization(pending, {
    fetch: oidc.fetch,
    now: () => 1_000,
    sleep: async () => {},
  })
  return { ...credential, expires: 0 }
}

/** A fresh PluginInput whose auth.set records every persisted credential and answers from `reply`. */
function recordingPluginInput(reply: () => unknown) {
  const persisted: Array<{ path: any; body: any }> = []
  // No configured models: the loader's context-limit lookup runs and falls back to its default.
  const input = fakePluginInput({
    models: {},
    client: {
      auth: {
        set: async (args: { path: any; body: any }) => {
          persisted.push(args)
          return reply()
        },
      },
    },
  })
  return { input, persisted }
}

const chatRequest = () => ({
  method: "POST",
  body: JSON.stringify({
    model: "claude-sonnet-4.6",
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  }),
})

describe("oauth loader", () => {
  /** OIDC refresh, an empty ListAvailableProfiles answer, and a one-frame chat reply. */
  const refreshAndChatUpstream = () =>
    routedFetch({
      [OIDC_TOKEN_URL]: () => jsonResponse({ accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 3600 }),
      [KIRO_MANAGEMENT_ENDPOINT]: () => jsonResponse({ profiles: [] }),
      [KIRO_ENDPOINT]: () =>
        chunkedResponse(
          encodeKiroEvent("assistantResponseEvent", { content: "hello" }),
          encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
        ),
    })

  /** Run the oauth loader of a plugin built over `upstream` and return the fetch it hands opencode. */
  const loadedFetch = async (input: PluginInput, upstream: RoutedFetch, credential: OAuthCredential) => {
    const loaderHooks = await createKiroPlugin("kiro", "oauth", { fetch: upstream.fetch })(input)
    const loaded = await loaderHooks.auth!.loader!(async () => credential, {} as any)
    return loaded.fetch as (url: string, init?: RequestInit) => Promise<Response>
  }

  it("loader persists the refreshed credential through client.auth.set", async () => {
    const upstream = refreshAndChatUpstream()
    const { input, persisted } = recordingPluginInput(() => ({}))
    const kiroFetch = await loadedFetch(input, upstream, await expiredDeviceFlowCredential())

    const response = await kiroFetch("https://api.anthropic.com/v1/messages", chatRequest())
    expect(response.status).toBe(200)
    await response.text()

    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.path).toEqual({ id: "kiro" })
    expect(persisted[0]!.body.type).toBe("oauth")
    expect(persisted[0]!.body.access).toBe("access-2")
    expect(decodeRefreshState(persisted[0]!.body.refresh).refreshToken).toBe("refresh-2")
    expect(persisted[0]!.body.expires).toBeGreaterThan(Date.now())

    expect(chatAuthorization(upstream)).toBe("Bearer access-2")
  })

  it("loader surfaces a client.auth.set error as the persist KiroAuthError", async () => {
    const upstream = refreshAndChatUpstream()
    const { input, persisted } = recordingPluginInput(() => ({ error: { name: "StorageError" } }))
    const kiroFetch = await loadedFetch(input, upstream, await expiredDeviceFlowCredential())

    const failure = await rejectionOf(kiroFetch("https://api.anthropic.com/v1/messages", chatRequest()))
    expect(failure).toBeInstanceOf(KiroAuthError)
    expect((failure as Error).message).toContain("persist")
    expect(persisted).toHaveLength(1)
    expect(upstream.calls.filter((call) => call.url === OIDC_TOKEN_URL)).toHaveLength(1)
    expect(upstream.calls.some((call) => call.url.startsWith(KIRO_ENDPOINT))).toBe(false)
  })

  it("loader retries the persist on the next request without a second OIDC refresh", async () => {
    const upstream = refreshAndChatUpstream()
    let storageHealthy = false
    const { input, persisted } = recordingPluginInput(() => (storageHealthy ? {} : { error: { name: "StorageError" } }))
    const kiroFetch = await loadedFetch(input, upstream, await expiredDeviceFlowCredential())

    await expect(kiroFetch("https://api.anthropic.com/v1/messages", chatRequest())).rejects.toBeInstanceOf(KiroAuthError)
    storageHealthy = true
    const response = await kiroFetch("https://api.anthropic.com/v1/messages", chatRequest())
    expect(response.status).toBe(200)
    await response.text()

    expect(persisted).toHaveLength(2)
    expect(persisted[1]!.body.access).toBe("access-2")
    expect(upstream.calls.filter((call) => call.url === OIDC_TOKEN_URL)).toHaveLength(1)
    expect(chatAuthorization(upstream)).toBe("Bearer access-2")
  })
})

describe("device-flow login methods", () => {
  const oauthMethods = (loginHooks = hooks) => loginHooks.auth!.methods as any[]
  const idcMethod = () => oauthMethods().find((method) => Array.isArray(method.prompts))

  it("IdC prompt validators return the normalizer message", () => {
    const prompts = idcMethod().prompts as Array<{ key: string; validate: (value: string) => string | undefined }>
    const startUrl = prompts.find((prompt) => prompt.key === "startUrl")!
    const region = prompts.find((prompt) => prompt.key === "region")!

    expect(startUrl.validate("https://mycompany.awsapps.com/start")).toBeUndefined()
    expect(startUrl.validate("http://mycompany.awsapps.com/start")).toBe(
      thrownMessage(() => normalizeStartUrl("http://mycompany.awsapps.com/start")),
    )
    expect(startUrl.validate("not a url")).toBe(thrownMessage(() => normalizeStartUrl("not a url")))

    expect(region.validate(" US-EAST-1 ")).toBeUndefined()
    expect(region.validate("nowhere")).toBe(thrownMessage(() => normalizeRegion("nowhere")))
    expect(region.validate("nowhere")).toContain("nowhere")
  })

  /** The Builder ID login method of a plugin whose device flow reaches OIDC through a routed fetch. */
  const builderIdLogin = async (device: Record<string, unknown>) => {
    const upstream = routedFetch({
      [`${OIDC_ENDPOINT}/client/register`]: () => jsonResponse({ clientId: "client-1", clientSecret: "secret-1" }),
      [`${OIDC_ENDPOINT}/device_authorization`]: () => jsonResponse(device),
    })
    const loginHooks = await createKiroPlugin("kiro", "oauth", { fetch: upstream.fetch })(fakePluginInput())
    const method = oauthMethods(loginHooks).find((method) => !Array.isArray(method.prompts))
    return { method, upstream }
  }

  it("deviceAuthorizationResult prefers verificationUriComplete and embeds the user code", async () => {
    const { method, upstream } = await builderIdLogin({
      deviceCode: "device-1",
      userCode: "WXYZ-1234",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234",
      expiresIn: 600,
      interval: 5,
    })
    const result = await method.authorize()
    expect(result.url).toBe("https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234")
    expect(result.instructions).toContain("WXYZ-1234")
    expect(result.method).toBe("auto")
    expect(typeof result.callback).toBe("function")
    expect(upstream.calls[1]?.body).toMatchObject({ startUrl: "https://view.awsapps.com/start" })
  })

  it("deviceAuthorizationResult falls back to verificationUri when the complete URI is absent", async () => {
    const { method } = await builderIdLogin({
      deviceCode: "device-1",
      userCode: "WXYZ-1234",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      expiresIn: 600,
    })
    const result = await method.authorize()
    expect(result.url).toBe("https://device.sso.us-east-1.amazonaws.com/")
    expect(result.instructions).toContain("WXYZ-1234")
  })
})
