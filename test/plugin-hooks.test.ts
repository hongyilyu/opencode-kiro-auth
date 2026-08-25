import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { KiroApiKeyPlugin, KiroAuthPlugin } from "../src/plugin"
import { resolveContextLimit } from "../src/limits"
import { isolateEnv } from "./support/isolation"

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

const pluginInput = { client: fakeClient } as unknown as PluginInput
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

  const toolError = async (messageID: string) => {
    const webSearchTool = apiHooks.tool!.web_search
    try {
      await webSearchTool.execute({ query: "test" }, { sessionID: "session", messageID, directory: "/tmp" } as never)
      return ""
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  it("web_search routes to oauth provider", async () => {
    delete process.env.KIRO_API_KEY
    expect(await toolError("oauth-message")).toContain("provider kiro")
  })

  it("web_search routes to api provider", async () => {
    delete process.env.KIRO_API_KEY
    expect(await toolError("api-message")).toContain("auth login --provider kiro-api")
  })
})

describe("context limits", () => {
  it("context limits cached per provider", async () => {
    const limitsClient = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              { id: "kiro", models: { model: { limit: { context: 111_111 } } } },
              { id: "kiro-api", models: { model: { limit: { context: 999_999 } } } },
            ],
          },
        }),
      },
    } as any
    expect(await resolveContextLimit(limitsClient, "kiro-api", "model")).toBe(999_999)
    expect(await resolveContextLimit(limitsClient, "kiro", "model")).toBe(111_111)
  })
})
