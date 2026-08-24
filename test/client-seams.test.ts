import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { fetchApiKeyProfileArn } from "../src/apikey"
import { KIRO_PROFILE_ARN_PLACEHOLDER } from "../src/constants"
import { createKiroFetch } from "../src/plugin"
import { getProfileArn } from "../src/profile"
import type { KiroSession } from "../src/session"
import { createTools } from "../src/tools"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/SEAMTEST"

const session: KiroSession = {
  async authHeaders() {
    return { authorization: "Bearer seam-token" }
  },
  async chatProfileArn() {
    return PROFILE_ARN
  },
  async mcpProfileArn() {
    return PROFILE_ARN
  },
}

describe("injected Kiro client seams", () => {
  it("runs the chat pipeline end to end without network access", async () => {
    let fetchCalls = 0
    const fetcher = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      fetchCalls++
      const headers = new Headers(init?.headers)
      expect(headers.get("x-amz-target")).toBe(
        "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      )
      expect(JSON.parse(String(init?.body)).profileArn).toBe(PROFILE_ARN)
      return chunkedResponse(encodeKiroEvent("assistantResponseEvent", { content: "offline reply" }))
    }) as unknown as typeof globalThis.fetch
    const input = {
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "kiro",
                  models: { "claude-sonnet-4.6": { limit: { context: 200_000 } } },
                },
              ],
            },
          }),
        },
      },
    } as unknown as PluginInput
    const kiroFetch = createKiroFetch("kiro", "oauth", input, async () => session, { fetch: fetcher })

    const response = await kiroFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "reply offline" }],
      }),
    })
    const sse = await response.text()

    expect(response.status).toBe(200)
    expect(fetchCalls).toBe(1)
    expect(sse).toContain('"type":"text_delta","text":"offline reply"')
    expect(sse).toContain('"type":"message_stop"')
  })

  it("runs web_search end to end without network access", async () => {
    let rpcBody: Record<string, any> | undefined
    const fetcher = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      rpcBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [
                    {
                      title: "Bun 1.3",
                      url: "https://bun.sh/blog/bun-v1.3",
                      snippet: "Bun 1.3 release notes",
                    },
                  ],
                }),
              },
            ],
          },
        }),
      )
    }) as unknown as typeof globalThis.fetch
    const tools = createTools(async () => session, { fetch: fetcher })

    const result = (await tools.web_search.execute(
      { query: "latest Bun release" } as never,
      { sessionID: "session", messageID: "message", directory: "/tmp" } as never,
    )) as any

    expect(rpcBody?.profileArn).toBe(PROFILE_ARN)
    expect(rpcBody?.method).toBe("tools/call")
    expect(rpcBody?.params?.arguments?.query).toBe("latest Bun release")
    expect(result.metadata.count).toBe(1)
    expect(result.output).toContain("[1] Bun 1.3")
    expect(result.output).toContain("https://bun.sh/blog/bun-v1.3")
  })
})

describe("credential-tier client seams", () => {
  it("falls through a GetProfile network error to the second region", async () => {
    const urls: string[] = []
    const fetcher = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input))
      if (urls.length === 1) throw new TypeError("offline region")
      return new Response(JSON.stringify({ profile: { arn: PROFILE_ARN } }))
    }) as unknown as typeof globalThis.fetch

    expect(await fetchApiKeyProfileArn("ksk_networkfallback", { fetch: fetcher })).toBe(PROFILE_ARN)
    expect(urls).toEqual([
      "https://management.us-east-1.kiro.dev/",
      "https://management.eu-central-1.kiro.dev/",
    ])
  })

  it("reports an error after both GetProfile regions reject", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response("{}", { status: 403 })
    }) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_allregionsfail", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(calls).toBe(2)
    expect(message).toContain("could not use the configured credential")
  })

  it("maps ListAvailableProfiles failure to the placeholder", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response("{}", { status: 503 })
    }) as unknown as typeof globalThis.fetch

    expect(await getProfileArn("list-profile-failure", { fetch: fetcher })).toBe(
      KIRO_PROFILE_ARN_PLACEHOLDER,
    )
    expect(calls).toBe(1)
  })
})
